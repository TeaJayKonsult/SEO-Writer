---

## 🔐 Security Notes

- Firestore security rules restrict users to their own documents (to be added before production).
- The welcome email endpoint verifies Firebase ID tokens before sending.
- Paystack webhook validates signatures and verifies transactions server‑side.

---

## 🧪 Testing

- **Sign up** – Use a real email address; check spam folder for welcome email.
- **Paystack test payment** – Use card `4242 4242 4242 4242` (any future expiry, any CVV).

---

## 📄 License

© 2026 TeaJay Konsult Ltd. All rights reserved.

---

## 👤 Author

**Pamilerin Adetunji Ajala** – CEO, TeaJay Konsult Ltd.  
[Portfolio](https://pamilerin-ajala.vercel.app) | [LinkedIn](https://linkedin.com/in/pamilerin-ajala) | [X](https://x.com/teejayconsult)

---

## 🙌 Acknowledgements

- Groq for free AI inference
- Vercel for hosting and serverless functions
- Firebase for Auth & Firestore
- Paystack for payment gateway
- Resend for email delivery
