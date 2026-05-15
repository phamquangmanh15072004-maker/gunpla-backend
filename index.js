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
const PAYOS_REQUEST_TIMEOUT_MS = Number(process.env.PAYOS_REQUEST_TIMEOUT_MS || 20000);
const FCM_REQUEST_TIMEOUT_MS = Number(process.env.FCM_REQUEST_TIMEOUT_MS || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
const AI_MAX_HISTORY = Number(process.env.AI_MAX_HISTORY || 30);
const AI_MAX_IMAGE_BYTES = Number(process.env.AI_MAX_IMAGE_BYTES || 5 * 1024 * 1024);

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

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function asString(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function takeText(value, maxLength) {
  return asString(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function verifyFirebaseBearer(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Missing Firebase ID token');
    error.statusCode = 401;
    throw error;
  }

  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    const authError = new Error('Invalid Firebase ID token');
    authError.statusCode = 401;
    throw authError;
  }
}

async function fetchProductsForAi() {
  const snapshot = await db.collection('products').where('isActive', '==', true).get();
  const products = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((product) => asNumber(product.stock) > 0)
    .sort((a, b) => {
      if (Boolean(a.isFeatured) !== Boolean(b.isFeatured)) return Number(Boolean(b.isFeatured)) - Number(Boolean(a.isFeatured));
      if (asNumber(a.sold) !== asNumber(b.sold)) return asNumber(b.sold) - asNumber(a.sold);
      if (asNumber(a.rating) !== asNumber(b.rating)) return asNumber(b.rating) - asNumber(a.rating);
      return asNumber(b.createdAt) - asNumber(a.createdAt);
    })
    .slice(0, 40);

  if (!products.length) {
    return 'Hien tai shop chua co san pham active con hang.';
  }

  return products.map((product) => {
    const discount = asNumber(product.originalPrice) > asNumber(product.price) && asNumber(product.originalPrice) > 0
      ? ` | Gia goc: ${asNumber(product.originalPrice)}d`
      : '';
    const description = takeText(product.description, 160);
    return `- ${asString(product.name)} | ID: ${asString(product.id)} | Gia: ${asNumber(product.price)}d | Danh muc/grade: ${asString(product.category, 'Chua phan loai')} | Ton: ${asNumber(product.stock)} | Rating: ${asNumber(product.rating)} | Da ban: ${asNumber(product.sold)}${discount}${description ? ` | Mo ta: ${description}` : ''}`;
  }).join('\n');
}

async function fetchPostsForAi() {
  const snapshot = await db.collection('posts')
    .where('status', '==', 'APPROVED')
    .limit(20)
    .get();

  if (snapshot.empty) {
    return 'Hien tai chua co bai marketplace nao duoc duyet.';
  }

  return snapshot.docs.map((doc) => {
    const post = { id: doc.id, ...doc.data() };
    const conditionText = post.condition === 'USED' ? 'Da rap/da dung' : 'Chua rap/moi';
    const content = takeText(post.content, 160);
    return `- ${asString(post.title)} | POST_ID: ${doc.id} | Gia pass: ${asNumber(post.price)}d | Grade: ${asString(post.grade)} | Nguoi ban: ${asString(post.userName)} | Tinh trang: ${conditionText}${content ? ` | Noi dung: ${content}` : ''}`;
  }).join('\n');
}

async function fetchOrdersForAi(uid) {
  const snapshot = await db.collection('orders').where('userId', '==', uid).get();
  if (snapshot.empty) {
    return 'Khach chua tung dat don hang nao.';
  }

  const orders = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => asNumber(b.createdAt) - asNumber(a.createdAt))
    .filter((order) => !['CANCELLED', 'COMPLETED', 'REFUNDED'].includes(asString(order.status)))
    .slice(0, 5);

  if (!orders.length) {
    return 'Khach hien khong co don hang dang xu ly.';
  }

  return orders.map((order) => {
    const items = Array.isArray(order.items)
      ? order.items.map((item) => `${asString(item.product?.name || item.productName, 'San pham')} x${asNumber(item.quantity, 1)}`).join(', ')
      : '';
    return `- Don #${asString(order.id).slice(-6).toUpperCase()} | Trang thai: ${asString(order.status)} | Thanh toan: ${asString(order.paymentStatus)} | San pham: [${items}]`;
  }).join('\n');
}

async function fetchCartForAi(uid) {
  const snapshot = await db.collection('carts').doc(uid).collection('items').limit(10).get();
  if (snapshot.empty) {
    return 'Gio hang hien dang trong.';
  }

  return snapshot.docs.map((doc) => {
    const item = doc.data();
    const product = item.product || {};
    return `- ${asString(product.name)} | ID: ${asString(product.id || doc.id)} | SL: ${asNumber(item.quantity, 1)} | Gia: ${asNumber(product.price)}d | Ton luc them gio: ${asNumber(product.stock)}`;
  }).join('\n');
}

async function buildAiSystemPrompt(uid) {
  const [productsInfo, postsInfo, ordersInfo, cartInfo] = await Promise.all([
    fetchProductsForAi(),
    fetchPostsForAi(),
    fetchOrdersForAi(uid),
    fetchCartForAi(uid),
  ]);

  return `
Ban la GunplaAI, tro ly tu van mua hang trong app StorePromax chuyen Gunpla.

KHO SHOP - chi tu van cac san pham ben duoi vi day la hang active va con ton:
${productsInfo}

MARKETPLACE CONG DONG - chi dung khi khach hoi hang pass/hang cu, can gia re hon, hoac shop khong co mau phu hop:
${postsInfo}

DON HANG CUA KHACH:
${ordersInfo}

GIO HANG CUA KHACH:
${cartInfo}

Quy tac tra loi:
1. Tra loi bang tieng Viet co dau, ngan gon, dung ngu canh app ban Gunpla. Khong bia san pham, gia, ton kho, trang thai don hoac bai marketplace ngoai du lieu duoc cung cap.
2. Khi goi y san pham cua shop, bat buoc gan ma o cuoi cau theo dang [ID: product_id]. Co the gan nhieu ma: [ID: id1, id2].
3. Khi goi y bai marketplace, bat buoc gan ma o cuoi cau theo dang [POST_ID: post_id]. Khong dung [ID] cho bai marketplace.
4. Uu tien shop truoc marketplace. Chi chuyen sang marketplace khi khach yeu cau hang pass/cu, muon re hon ro rang, hoac shop khong co lua chon phu hop.
5. Neu khach muon mua nhung chua ro so luong, hay hoi lai so luong. Neu da ro san pham va so luong, xac nhan tu nhien roi gan duy nhat mot lenh [AUTO_CART: product_id, quantity].
6. Khong dung [AUTO_CART] cho san pham het hang, marketplace, hoac khi khach chi dang hoi tu van.
7. Khi khach hoi don hang, dua vao muc DON HANG CUA KHACH. Neu khong co du lieu phu hop, noi ro chua thay don tuong ung trong he thong.
8. Khi khach gui anh, mo ta nhan dien o muc than trong, sau do goi y mau shop gan nhat con hang; neu khong co thi moi goi y marketplace.
`.trim();
}

function normalizeAiHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-AI_MAX_HISTORY)
    .map((item) => {
      const role = item && item.role === 'model' ? 'model' : 'user';
      const text = takeText(item && item.content, 4000);
      return text ? { role, parts: [{ text }] } : null;
    })
    .filter(Boolean);
}

async function fetchImageAsInlineData(imageUrl) {
  const url = asString(imageUrl).trim();
  if (!url) return null;
  if (!/^https:\/\/res\.cloudinary\.com\//i.test(url)) {
    const error = new Error('Only Cloudinary HTTPS image URLs are accepted');
    error.statusCode = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error('Cannot fetch uploaded image');
      error.statusCode = 400;
      throw error;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      const error = new Error('Uploaded file is not an image');
      error.statusCode = 400;
      throw error;
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > AI_MAX_IMAGE_BYTES) {
      const error = new Error('Image is too large');
      error.statusCode = 413;
      throw error;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > AI_MAX_IMAGE_BYTES) {
      const error = new Error('Image is too large');
      error.statusCode = 413;
      throw error;
    }

    return {
      inline_data: {
        mime_type: contentType.split(';')[0],
        data: Buffer.from(arrayBuffer).toString('base64'),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini({ systemPrompt, history, message, imageUrl }) {
  if (!GEMINI_API_KEY) {
    const error = new Error('Gemini API key is not configured');
    error.statusCode = 503;
    throw error;
  }

  const userText = takeText(message, 8000);
  const parts = [];
  const inlineImage = await fetchImageAsInlineData(imageUrl);
  if (inlineImage) parts.push(inlineImage);
  if (userText) parts.push({ text: userText });

  if (!parts.length) {
    const error = new Error('Message or image is required');
    error.statusCode = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          ...normalizeAiHistory(history),
          { role: 'user', parts },
        ],
        generationConfig: {
          temperature: 0.55,
          topP: 0.9,
          maxOutputTokens: 1400,
        },
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messageText = data.error?.message || `Gemini request failed with ${response.status}`;
      const error = new Error(messageText);
      error.statusCode = response.status >= 500 ? 503 : 400;
      throw error;
    }

    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();

    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason || 'EMPTY_RESPONSE';
      const error = new Error(`Gemini returned no text: ${finishReason}`);
      error.statusCode = 502;
      throw error;
    }

    return text;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Gemini request timed out');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function renderPayosResultPage({ title, message, status, orderCode }) {
  const safeTitle = takeText(title, 120);
  const safeMessage = takeText(message, 300);
  const safeStatus = takeText(status, 80) || 'UNKNOWN';
  const safeOrderCode = takeText(orderCode, 40);

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    section { max-width: 520px; width: 100%; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 8px 0; line-height: 1.55; color: #475569; }
    .meta { margin-top: 18px; padding: 12px; background: #f1f5f9; border-radius: 10px; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      <p>Vui lòng quay lại ứng dụng Gunpla Hub để kiểm tra trạng thái đơn hàng mới nhất.</p>
      <div class="meta">
        <div>Trạng thái PayOS: <strong>${safeStatus}</strong></div>
        ${safeOrderCode ? `<div>Mã PayOS: <strong>${safeOrderCode}</strong></div>` : ''}
      </div>
    </section>
  </main>
</body>
</html>`;
}

app.get('/payos-return', (req, res) => {
  const status = req.query.status || req.query.code || 'RETURNED';
  const orderCode = req.query.orderCode || req.query.id || '';

  res.status(200).send(renderPayosResultPage({
    title: 'Đã quay lại từ PayOS',
    message: 'Thanh toán của bạn đang được hệ thống xác nhận qua webhook PayOS.',
    status,
    orderCode,
  }));
});

app.get('/payos-cancel', (req, res) => {
  const status = req.query.status || req.query.code || 'CANCELLED';
  const orderCode = req.query.orderCode || req.query.id || '';

  res.status(200).send(renderPayosResultPage({
    title: 'Thanh toán đã bị hủy',
    message: 'Bạn đã hủy thanh toán hoặc rời khỏi màn hình PayOS trước khi hoàn tất.',
    status,
    orderCode,
  }));
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
    const paymentLink = await withTimeout(
      payos.paymentRequests.create({
        orderCode,
        amount,
        description,
        cancelUrl: CANCEL_URL,
        returnUrl: RETURN_URL,
      }),
      PAYOS_REQUEST_TIMEOUT_MS,
      'PayOS create payment link timed out',
    );

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
    if (error.statusCode === 504) {
      return res.status(504).json({ success: false, message: 'Payment gateway timed out. Please try again.' });
    }
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
      android: {
        priority: 'high',
      },
    };

    if (targetToken) {
      payload.token = targetToken;
    } else {
      payload.topic = topic;
    }

    const response = await withTimeout(
      admin.messaging().send(payload),
      FCM_REQUEST_TIMEOUT_MS,
      'FCM send timed out',
    );
    res.status(200).json({ success: true, message: 'FCM sent', response });
  } catch (error) {
    console.error('FCM send failed:', error.message);
    const status = error.statusCode === 504 ? 504 : 400;
    res.status(status).json({ success: false, error: error.message });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const decodedToken = await verifyFirebaseBearer(req);
    const uid = decodedToken.uid;
    const message = asString(req.body.message).trim();
    const imageUrl = asString(req.body.imageUrl).trim();

    if (!message && !imageUrl) {
      return res.status(400).json({
        success: false,
        errorCode: 'EMPTY_MESSAGE',
        message: 'Message or imageUrl is required',
      });
    }

    const systemPrompt = await buildAiSystemPrompt(uid);
    const aiText = await callGemini({
      systemPrompt,
      history: req.body.history,
      message,
      imageUrl,
    });

    return res.status(200).json({
      success: true,
      text: aiText,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    const errorCode = status === 401
      ? 'UNAUTHORIZED'
      : status === 400
        ? 'BAD_REQUEST'
        : status === 413
          ? 'IMAGE_TOO_LARGE'
          : status === 504
            ? 'AI_TIMEOUT'
            : status === 503
              ? 'AI_UNAVAILABLE'
              : 'AI_ERROR';

    console.error('AI chat failed:', {
      status,
      errorCode,
      message: error.message,
    });

    return res.status(status).json({
      success: false,
      errorCode,
      message: status >= 500 ? 'AI service is temporarily unavailable' : error.message,
    });
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
          await withTimeout(
            payos.paymentRequests.cancel(payosId, 'Qua thoi gian thanh toan'),
            PAYOS_REQUEST_TIMEOUT_MS,
            'PayOS cancel payment link timed out',
          );
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
