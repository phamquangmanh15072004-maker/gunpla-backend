require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { PayOS } = require('@payos/node');

const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const payos = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID,
  apiKey: process.env.PAYOS_API_KEY,
  checksumKey: process.env.PAYOS_CHECKSUM_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

const PAYMENT_TIMEOUT_MS = Number(process.env.PAYMENT_TIMEOUT_MS || 5 * 60 * 1000);
const ORDER_SWEEP_INTERVAL_MS = Number(process.env.ORDER_SWEEP_INTERVAL_MS || 60 * 1000);
const RETURN_URL = process.env.PAYOS_RETURN_URL || 'https://google.com';
const CANCEL_URL = process.env.PAYOS_CANCEL_URL || 'https://google.com';

function now() {
  return Date.now();
}

function normalizeCreatedAt(value) {
  const ts = Number(value || 0);
  return ts > 0 && ts < 10_000_000_000 ? ts * 1000 : ts;
}

function createPayOSOrderCode() {
  // payOS requires a numeric orderCode. Firestore order ids can be UUIDs.
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function getOrderProductReservations(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items
    .map((item) => {
      const productId = item.product?.id || item.productId;
      const quantity = Number(item.quantity || 0);
      return productId && quantity > 0 ? { productId, quantity } : null;
    })
    .filter(Boolean);
}

async function findVoucherRefs(order) {
  async function findRefs(code) {
    if (!code || !order.userId) {
      return { globalRef: null, userRef: null };
    }

    const [globalSnap, userSnap] = await Promise.all([
      db.collection('vouchers').where('code', '==', code).limit(1).get(),
      db.collection('user_vouchers')
        .where('userId', '==', order.userId)
        .where('voucher.code', '==', code)
        .limit(1)
        .get(),
    ]);

    return {
      globalRef: globalSnap.empty ? null : globalSnap.docs[0].ref,
      userRef: userSnap.empty ? null : userSnap.docs[0].ref,
    };
  }

  const [discount, freeship] = await Promise.all([
    findRefs(order.discountCode),
    findRefs(order.freeshipCode),
  ]);

  return { discount, freeship };
}

async function releaseOrderReservations(orderRef, reason, status = 'CANCELLED') {
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { changed: false, reason: 'ORDER_NOT_FOUND' };

  const order = orderSnap.data();
  const voucherRefs = await findVoucherRefs(order);

  return db.runTransaction(async (transaction) => {
    const freshSnap = await transaction.get(orderRef);
    if (!freshSnap.exists) return { changed: false, reason: 'ORDER_NOT_FOUND' };

    const freshOrder = freshSnap.data();
    if (freshOrder.paymentStatus === 'PAID') {
      return { changed: false, reason: 'ORDER_ALREADY_PAID' };
    }
    if (['CANCELLED', 'REFUNDING', 'REFUNDED'].includes(freshOrder.status)) {
      return { changed: false, reason: 'ORDER_ALREADY_RELEASED' };
    }

    transaction.update(orderRef, {
      status,
      cancelReason: reason,
      cancelledBy: status === 'CANCELLED' ? 'SYSTEM' : (freshOrder.cancelledBy || 'SYSTEM'),
      updatedAt: now(),
    });

    for (const item of getOrderProductReservations(freshOrder)) {
      const productRef = db.collection('products').doc(item.productId);
      transaction.update(productRef, {
        stock: FieldValue.increment(item.quantity),
        sold: FieldValue.increment(-item.quantity),
      });
    }

    function restoreGlobalVoucher(ref) {
      if (ref) {
        transaction.update(ref, {
          usedCount: FieldValue.increment(-1),
        });
      }
    }

    function restoreUserVoucher(ref) {
      if (ref) {
        transaction.update(ref, {
          status: 'AVAILABLE',
        });
      }
    }

    restoreGlobalVoucher(voucherRefs.discount.globalRef);
    restoreGlobalVoucher(voucherRefs.freeship.globalRef);
    restoreUserVoucher(voucherRefs.discount.userRef);
    restoreUserVoucher(voucherRefs.freeship.userRef);

    return { changed: true, reason: 'RELEASED' };
  });
}

async function markOrderPaid({ orderCode, amount, paymentLinkId, reference, rawWebhookData }) {
  const orderCodeNumber = Number(orderCode);
  if (!Number.isSafeInteger(orderCodeNumber)) {
    return { changed: false, reason: 'INVALID_ORDER_CODE' };
  }

  const mappingSnap = await db.collection('payos_orders').doc(String(orderCodeNumber)).get();
  let orderRef = null;
  let matchedByMapping = false;

  if (mappingSnap.exists && mappingSnap.get('orderId')) {
    orderRef = db.collection('orders').doc(String(mappingSnap.get('orderId')));
    matchedByMapping = true;
  } else {
    const snapshot = await db.collection('orders')
      .where('payosOrderCode', '==', orderCodeNumber)
      .limit(1)
      .get();
    if (!snapshot.empty) {
      orderRef = snapshot.docs[0].ref;
    }
  }

  if (!orderRef) return { changed: false, reason: 'ORDER_NOT_FOUND' };

  return db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) return { changed: false, reason: 'ORDER_NOT_FOUND' };

    const order = orderSnap.data();
    if (!matchedByMapping && order.payosOrderCode && Number(order.payosOrderCode) !== orderCodeNumber) {
      transaction.set(db.collection('notifications').doc(), {
        title: `Thanh toan link cu #${orderSnap.id.slice(-6).toUpperCase()}`,
        message: `PayOS bao thanh toan cho orderCode ${orderCodeNumber}, nhung don hien tai dang gan voi orderCode ${order.payosOrderCode}. Can doi soat.`,
        type: 'PAYMENT_STALE_LINK',
        targetId: orderSnap.id,
        targetRoles: ['ADMIN'],
        readBy: [],
        createdAt: now(),
      });
      return { changed: false, reason: 'STALE_PAYMENT_LINK', orderId: orderSnap.id };
    }
    if (order.paymentStatus === 'PAID') {
      return { changed: false, reason: 'ALREADY_PAID', orderId: orderSnap.id };
    }
    if (['CANCELLED', 'REFUNDING', 'REFUNDED'].includes(order.status)) {
      transaction.set(db.collection('notifications').doc(), {
        title: `Thanh toan tre #${orderSnap.id.slice(-6).toUpperCase()}`,
        message: `Don hang da bi huy nhung PayOS bao da nhan tien. Can kiem tra hoan tien. Ma GD: ${reference || ''}`,
        type: 'PAYMENT_LATE',
        targetId: orderSnap.id,
        targetRoles: ['ADMIN'],
        readBy: [],
        createdAt: now(),
      });
      return { changed: false, reason: 'ORDER_ALREADY_CANCELLED', orderId: orderSnap.id };
    }
    if (Number(order.totalPrice || 0) !== Number(amount || 0)) {
      transaction.set(db.collection('notifications').doc(), {
        title: `Sai so tien thanh toan #${orderSnap.id.slice(-6).toUpperCase()}`,
        message: `PayOS bao ${amount}, don hang he thong la ${order.totalPrice}. Can doi soat thu cong.`,
        type: 'PAYMENT_AMOUNT_MISMATCH',
        targetId: orderSnap.id,
        targetRoles: ['ADMIN'],
        readBy: [],
        createdAt: now(),
      });
      return { changed: false, reason: 'AMOUNT_MISMATCH', orderId: orderSnap.id };
    }

    transaction.update(orderRef, {
      paymentStatus: 'PAID',
      status: 'PENDING',
      payosPaymentLinkId: paymentLinkId || order.payosPaymentLinkId || '',
      payosReference: reference || '',
      paidAt: now(),
      updatedAt: now(),
      payosWebhookData: rawWebhookData || null,
    });

    transaction.set(db.collection('notifications').doc(), {
      title: `Thanh toan thanh cong #${orderSnap.id.slice(-6).toUpperCase()}`,
      message: `Don hang #${orderSnap.id} da duoc thanh toan qua PayOS.`,
      type: 'PAYMENT_SUCCESS',
      targetId: orderSnap.id,
      targetRoles: ['ADMIN', 'INVENTORY'],
      readBy: [],
      createdAt: now(),
    });

    return { changed: true, reason: 'PAID', orderId: orderSnap.id };
  });
}

app.get('/', (req, res) => {
  res.status(200).send('Gunpla Server is awake and running!');
});

app.post('/create-payment-link', async (req, res) => {
  try {
    const orderId = String(req.body.orderId || '').trim();
    const amount = Number(req.body.amount || 0);

    if (!orderId || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid orderId or amount' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = orderSnap.data();
    if (order.paymentMethod !== 'BANKING' || order.status !== 'AWAITING_PAYMENT') {
      return res.status(409).json({ success: false, message: 'Order is not awaiting bank payment' });
    }
    if (order.paymentStatus === 'PAID') {
      return res.status(409).json({ success: false, message: 'Order already paid' });
    }
    if (Number(order.totalPrice || 0) !== amount) {
      return res.status(400).json({ success: false, message: 'Payment amount mismatch' });
    }

    if (order.payosCheckoutUrl && order.payosOrderCode) {
      return res.status(200).json({
        success: true,
        checkoutUrl: order.payosCheckoutUrl,
        bin: order.payosBin || '',
        accountNumber: order.payosAccountNumber || '',
        description: order.payosDescription || '',
      });
    }

    const orderCode = createPayOSOrderCode();
    const description = `DH ${orderId.replace(/-/g, '').slice(-12).toUpperCase()}`;
    const paymentLink = await payos.paymentRequests.create({
      orderCode,
      amount,
      description,
      cancelUrl: CANCEL_URL,
      returnUrl: RETURN_URL,
    });

    await orderRef.update({
      payosOrderCode: orderCode,
      payosPaymentLinkId: paymentLink.paymentLinkId || '',
      payosCheckoutUrl: paymentLink.checkoutUrl || '',
      payosBin: paymentLink.bin || '',
      payosAccountNumber: paymentLink.accountNumber || '',
      payosDescription: paymentLink.description || description,
      updatedAt: now(),
    });
    await db.collection('payos_orders').doc(String(orderCode)).set({
      orderId,
      amount,
      paymentLinkId: paymentLink.paymentLinkId || '',
      createdAt: now(),
    });

    return res.status(200).json({
      success: true,
      checkoutUrl: paymentLink.checkoutUrl,
      bin: paymentLink.bin,
      accountNumber: paymentLink.accountNumber,
      description: paymentLink.description || description,
    });
  } catch (error) {
    console.error('Create payment link failed:', error);
    return res.status(500).json({ success: false, message: `Cannot create payment link: ${error.message}` });
  }
});

app.post('/payos-webhook', async (req, res) => {
  try {
    const webhookData = await payos.webhooks.verify(req.body);

    if (req.body.code !== '00' || req.body.success !== true || webhookData.code !== '00') {
      return res.json({ success: true });
    }

    const result = await markOrderPaid({
      orderCode: webhookData.orderCode,
      amount: webhookData.amount,
      paymentLinkId: webhookData.paymentLinkId,
      reference: webhookData.reference,
      rawWebhookData: webhookData,
    });

    console.log('PayOS webhook handled:', result);
    return res.json({ success: true });
  } catch (error) {
    console.error('PayOS webhook rejected:', error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/send-fcm', async (req, res) => {
  const { targetToken, topic, title, body, type, orderId, action, channelId, postId, targetId, imageUrl } = req.body;

  if (!targetToken && !topic) {
    return res.status(400).json({ success: false, error: 'Missing FCM token or topic' });
  }

  try {
    const payload = {
      notification: {
        title: String(title || 'Thong bao moi'),
        body: String(body || 'Ban co mot thong bao tu he thong'),
      },
      data: {
        title: String(title || 'Thong bao moi'),
        body: String(body || 'Ban co mot thong bao tu he thong'),
        type: String(type || 'SYSTEM'),
        orderId: String(orderId || ''),
        postId: String(postId || ''),
        targetId: String(targetId || ''),
        action: String(action || ''),
        channelId: String(channelId || ''),
        imageUrl: String(imageUrl || ''),
      },
    };

    if (targetToken) {
      payload.token = targetToken;
    } else {
      payload.topic = topic;
    }

    const response = await admin.messaging().send(payload);
    res.status(200).json({ success: true, message: 'FCM sent', response });
  } catch (error) {
    console.error('FCM send failed:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

console.log('Starting low stock watcher...');
db.collection('products').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type !== 'modified') return;

    const product = change.doc.data();
    const productId = change.doc.id;
    const stock = Number(product.stock || 0);
    const isLowStockNotified = product.isLowStockNotified || false;

    if (stock <= 5 && !isLowStockNotified) {
      try {
        await db.collection('notifications').add({
          title: 'Canh bao kho hang',
          message: `San pham ${product.name} chi con ${stock} hop. Vui long kiem tra va nhap them.`,
          type: 'INVENTORY',
          targetId: productId,
          targetRoles: ['ADMIN', 'INVENTORY'],
          readBy: [],
          createdAt: now(),
        });
        await db.collection('products').doc(productId).update({ isLowStockNotified: true });
      } catch (error) {
        console.error('Low stock notification failed:', error.message);
      }
    }

    if (stock > 5 && isLowStockNotified) {
      try {
        await db.collection('products').doc(productId).update({ isLowStockNotified: false });
      } catch (error) {
        console.error('Low stock reset failed:', error.message);
      }
    }
  });
}, (error) => {
  console.error('Low stock watcher failed:', error.message);
});

async function sweepExpiredPaymentOrders() {
  const startedAt = now();
  const expiredBefore = startedAt - PAYMENT_TIMEOUT_MS;
  const snapshot = await db.collection('orders')
    .where('status', '==', 'AWAITING_PAYMENT')
    .get();

  let canceledCount = 0;
  for (const doc of snapshot.docs) {
    const order = doc.data();
    const createdAt = normalizeCreatedAt(order.createdAt);
    if (!createdAt || createdAt > expiredBefore) continue;

    const result = await releaseOrderReservations(
      doc.ref,
      'He thong tu dong huy do qua thoi gian thanh toan',
      'CANCELLED',
    );

    if (result.changed) {
      canceledCount += 1;
      const payosId = order.payosPaymentLinkId || order.payosOrderCode;
      if (payosId) {
        try {
          await payos.paymentRequests.cancel(payosId, 'Qua thoi gian thanh toan');
        } catch (error) {
          console.warn(`PayOS cancel skipped for ${doc.id}: ${error.message}`);
        }
      }
    }
  }

  if (canceledCount > 0) {
    console.log(`Canceled ${canceledCount} expired payment orders.`);
  }
}

console.log('Starting expired order sweeper...');
setInterval(() => {
  sweepExpiredPaymentOrders().catch((error) => {
    console.error('Expired order sweep failed:', error.message);
  });
}, ORDER_SWEEP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gunpla Backend is running on port ${PORT}`);
});
