require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { PayOS } = require('@payos/node');

// ==========================================
// 1. KHỞI TẠO FIREBASE & PAYOS
// ==========================================
const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const payos = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID, 
  apiKey: process.env.PAYOS_API_KEY, 
  checksumKey: process.env.PAYOS_CHECKSUM_KEY
});

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('Gunpla Server is awake and running!');
});

// ==========================================
// API 1: TẠO LINK THANH TOÁN (ĐÃ FIX LỖI 231 CHUẨN 100%)
// Tự động làm mới QR Code mà không tạo đơn hàng rác
// ==========================================
app.post('/create-payment-link', async (req, res) => {
    try {
        const body = req.body; 
        const orderCodeNum = Number(body.orderId); // Phải ép về số cho PayOS

        const requestData = {
            orderCode: orderCodeNum, 
            amount: Number(body.amount),     
            description: body.description || "Thanh toan don hang",
            cancelUrl: "https://google.com", 
            returnUrl: "https://google.com"  
        };

        // 1. Thử tạo link thanh toán mới
        const paymentLinkRes = await payos.paymentRequests.create(requestData);

        // Trả về nếu thành công ngay lần đầu
        return res.json({
            success: true,
            checkoutUrl: paymentLinkRes.checkoutUrl,
            bin: paymentLinkRes.bin,
            accountNumber: paymentLinkRes.accountNumber,
            description: paymentLinkRes.description 
        });

    } catch (error) {
        // 2. BẮT LỖI: Kiểm tra xem có phải lỗi 231 (Đã tồn tại) không?
        const isExistError = error.code === '231' || (error.message && error.message.includes('231'));

        if (isExistError) {
            console.log(`⚠️ Đơn ${req.body.orderId} bị lỗi 231. Đang làm mới phiên giao dịch PayOS...`);
            
            try {
                // Bước A: Bảo PayOS HỦY cái mã QR cũ bị treo đi (Không ảnh hưởng Firebase)
                await payos.cancelPaymentLink(Number(req.body.orderId), "Khách yêu cầu mã QR mới");

                // Bước B: Yêu cầu PayOS cấp lại 1 mã QR mới tinh cho CHÍNH ĐƠN HÀNG ĐÓ
                const requestDataRetry = {
                    orderCode: Number(req.body.orderId), 
                    amount: Number(req.body.amount),     
                    description: req.body.description || "Thanh toan don hang",
                    cancelUrl: "https://google.com", 
                    returnUrl: "https://google.com"  
                };
                
                const newPaymentLinkRes = await payos.paymentRequests.create(requestDataRetry);

                console.log("✅ Đã làm mới mã QR thành công cho App Android!");
                
                // Trả mã QR mới về cho điện thoại
                return res.json({
                    success: true,
                    checkoutUrl: newPaymentLinkRes.checkoutUrl,
                    bin: newPaymentLinkRes.bin,
                    accountNumber: newPaymentLinkRes.accountNumber,
                    description: newPaymentLinkRes.description 
                });

            } catch (retryError) {
                console.error("❌ Lỗi khi làm mới mã QR:", retryError.message);
                return res.status(500).json({ success: false, message: "Không thể tạo mã QR mới: " + retryError.message });
            }
        }

        console.error("❌ Lỗi tạo link:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API 2: NHẬN WEBHOOK TỪ PAYOS
// ==========================================
app.post('/payos-webhook', async (req, res) => {
    try {
        console.log("🔥 Đã nhận được Webhook từ PayOS!");

        const data = req.body.data;
        if (!data) return res.json({ success: true });

        if (req.body.code === "00" || req.body.success === true) {
            const orderId = String(data.orderCode); 
            console.log(`✅ Khách đã chuyển tiền cho đơn: ${orderId}.`);

            const ordersRef = db.collection('orders');
            const snapshot = await ordersRef.where('id', '==', orderId).get();

            if (snapshot.empty) {
                console.log(`❌ CẢNH BÁO: Firebase không có đơn hàng mang id = ${orderId}`);
            } else {
                // 1. Cập nhật trạng thái đơn hàng
                const batch = db.batch();
                snapshot.forEach(doc => {
                    batch.update(doc.ref, {
                        paymentStatus: 'PAID', 
                        updatedAt: Date.now()
                    });
                });
                await batch.commit();
                console.log("🎉 Cập nhật trạng thái PAID thành công!");

                // 2. TỰ ĐỘNG BÁO CHUÔNG CHO WEB ADMIN
                await db.collection('notifications').add({
                    title: `Thanh toán thành công #${orderId}`,
                    message: `Đơn hàng #${orderId} đã được thanh toán qua PayOS.`,
                    targetRoles: ['ADMIN', 'INVENTORY'], 
                    readBy: [],
                    createdAt: Date.now()
                });
                console.log("🔔 Đã reo chuông cho Web Admin!");
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error("❌ Lỗi xử lý Webhook:", error.message);
        res.json({ success: false }); // Trả về false để PayOS biết đường gọi lại nếu cần
    }
});

// ==========================================
// API 3: BẮN THÔNG BÁO FCM (ĐÃ FIX CHUẨN 100%)
// Chống sập Server 500, Hỗ trợ DeepLink mở App
// ==========================================
app.post('/api/send-fcm', async (req, res) => {
    // 🌟 Lấy ĐẦY ĐỦ các trường từ Android / Web gửi lên
    const { targetToken, topic, title, body, type, orderId, action, channelId, imageUrl } = req.body;

    if (!targetToken && !topic) {
        return res.status(400).json({ success: false, error: "Thiếu FCM Token hoặc Topic" });
    }

    try {
        // Gói dữ liệu gửi đi (Payload)
        const payload = {
            notification: { 
                title: String(title || 'Thông báo mới'), 
                body: String(body || 'Bạn có một thông báo từ hệ thống')
            },
            data: { 
                // 🌟 THÊM 2 DÒNG NÀY VÀO CỤC DATA ĐỂ APP ĐỌC ĐƯỢC LÚC ĐANG MỞ
                title: String(title || 'Thông báo mới'),                   // 👈 BẠN ĐANG THIẾU DÒNG NÀY
                body: String(body || 'Bạn có một thông báo từ hệ thống'),  // 👈 BẠN ĐANG THIẾU DÒNG NÀY
                type: String(type || 'SYSTEM'), 
                orderId: String(orderId || ''),
                action: String(action || ''),
                channelId: String(channelId || ''),
                imageUrl: String(imageUrl || '')
            }
        };

        // Gắn token (gửi cho 1 người) hoặc topic (gửi cho nhóm)
        if (targetToken) {
            payload.token = targetToken;
        } else if (topic) {
            payload.topic = topic;
        }

        // Dùng Firebase Admin bắn thông báo
        const response = await admin.messaging().send(payload);
        console.log('✅ Đã bắn FCM thành công:', response);
        
        res.status(200).json({ success: true, message: "Đã gửi thông báo FCM!" });
    } catch (error) {
        // 🌟 BẮT LỖI TẠI ĐÂY ĐỂ KHÔNG BỊ SẬP SERVER TRẢ VỀ 500
        console.error('❌ Lỗi khi bắn FCM (Có thể do Token sai/cũ):', error.message);
        // Trả về 400 (Bad Request) để client biết Token hỏng, server vẫn sống khỏe
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==========================================
// 4. LÍNH GÁC KHO (AUTO LOW STOCK ALERT)
// Tự động lắng nghe sự thay đổi của bảng 'products'
// ==========================================
console.log("👀 Đang khởi động hệ thống Lính Gác Kho...");

db.collection('products').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
        // Chỉ quan tâm khi có sản phẩm bị thay đổi (modified)
        if (change.type === 'modified') {
            const product = change.doc.data();
            const productId = change.doc.id;
            const stock = Number(product.stock || 0);
            const isLowStockNotified = product.isLowStockNotified || false;

            // 🚨 Kịch bản 1: Sập bẫy (Tồn kho <= 5 và CHƯA báo động)
            if (stock <= 5 && !isLowStockNotified) {
                console.log(`⚠️ CẢNH BÁO: ${product.name} sắp hết (${stock} hộp). Đang reo chuông!`);
                
                try {
                    // 1. Reo chuông trên Web Admin
                    await db.collection('notifications').add({
                        title: "CẢNH BÁO KHO HÀNG ⚠️",
                        message: `Sản phẩm ${product.name} chỉ còn ${stock} hộp! Vui lòng kiểm tra và nhập thêm.`,
                        type: "INVENTORY",
                        targetId: productId, // Truyền ID để Admin click vào bay đến SP
                        targetRoles: ['ADMIN', 'INVENTORY'], // Sếp và Thủ kho sẽ thấy
                        readBy: [],
                        createdAt: Date.now()
                    });

                    // 2. Chốt bẫy (Đánh dấu đã báo động để không spam)
                    await db.collection('products').doc(productId).update({
                        isLowStockNotified: true
                    });
                    console.log(`🔒 Đã chốt bẫy cảnh báo cho ${product.name}`);
                } catch (error) {
                    console.error("❌ Lỗi khi reo chuông kho hàng:", error);
                }
            }
            
            // 🟢 Kịch bản 2: Cài lại bẫy (Khách hủy đơn HOẶC Thủ kho nhập thêm hàng > 5)
            if (stock > 5 && isLowStockNotified) {
                console.log(`✅ Tồn kho ${product.name} đã an toàn (${stock} hộp). Đang cài lại bẫy!`);
                try {
                    await db.collection('products').doc(productId).update({
                        isLowStockNotified: false
                    });
                } catch (error) {
                    console.error("❌ Lỗi khi cài lại bẫy kho hàng:", error);
                }
            }
        }
    });
}, (error) => {
    console.error("❌ Lỗi Lính Gác Kho:", error);
});

// ==========================================
// KHỞI ĐỘNG SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Gunpla Backend đang chạy tại cổng ${PORT}`);
});