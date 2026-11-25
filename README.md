# مدينة المتابعين — دليل التشغيل

الفكرة: أي واحد يعلّق على بوستك بانستغرام، ManyChat يبلّغ السيرفر، والسيرفر يسويله بيت ويطلّع رابط دخول خاص بيه، وManyChat يدزله الرابط بالدايركت. يضغط الرابط فيدخل لبيته ويلوّنه ويكتب جملة على بابه.

كل ما يعلّق أكثر، بيته يكبر: ٣ تعليقات = طابقين، ٧ تعليقات = ثلاث طوابق، ٥ تعليقات = سيارة كدام البيت.

---

## الجزء الأول: رفع الموقع على Cloudflare (مجاني) — من الماك

١. نزّل **Node.js** (نسخة LTS) من nodejs.org ونصّبه.

٢. سوِّ حساب مجاني على **dash.cloudflare.com**.

٣. فك ضغط ملف المشروع، وافتح **Terminal**، واكتب (بدّل المسار بمكان المجلد):

```
cd ~/Downloads/city-site
npm install
npx wrangler login
```
راح ينفتح المتصفح، وافق على الدخول.

٤. سوِّ قاعدة البيانات:
```
npx wrangler d1 create city-db
```
راح يطلعلك سطر بيه `database_id = "..."`. انسخ الرقم وحطه بملف **wrangler.toml** بدال `PUT_DATABASE_ID_HERE`.

٥. جهّز جدول السكان:
```
npx wrangler d1 execute city-db --remote --file=schema.sql
```

٦. حط كلمة سر بين ManyChat والسيرفر (اختار كلمة طويلة واحفظها، تحتاجها بعدين):
```
npx wrangler secret put CITY_SECRET
```

٧. ارفع الموقع:
```
npx wrangler deploy
```
راح يطلعلك رابط مثل `https://followers-city.xxxx.workers.dev`. هذا رابط مدينتك.

٨. افتح **wrangler.toml** وحط هذا الرابط بمكان `SITE_URL`، وبعدين ارفع مرة ثانية:
```
npx wrangler deploy
```

جرّب: افتح الرابط، لازم تطلع المدينة فارغة وبالنص الساحة.

---

## الجزء الثاني: ManyChat

### أ. الربط
١. سوِّ حساب على **manychat.com** واربط حساب انستغرام (لازم يكون احترافي: Creator أو Business).
٢. ميزة **External Request** تحتاج اشتراك **Pro**. شوف السعر الحالي بصفحة الأسعار عندهم.
٣. من Settings ← Fields سوِّ **Custom Fields** نوعها Text:
`city_link` ، `house_no` ، `floors` ، `is_new` ، `level_up`

### ب. أتمتة التعليقات (الأساسية)
١. Automation جديدة ← Trigger: **User comments on your Post or Reel** ← اختار البوست (أو كل البوستات) ← خليها تشتغل على **أي تعليق**.
٢. أول خطوة: **Action ← External Request**
   - Method: **POST**
   - URL: `https://رابط-مدينتك/api/join`
   - Headers: `x-city-secret` = كلمة السر اللي حطيتها بالخطوة ٦، و`content-type` = `application/json`
   - Body (JSON):
   ```
   {"username": "{{Instagram Username}}", "name": "{{First Name}}", "ig_id": "{{Contact Id}}"}
   ```
   الحقول اللي بين `{{ }}` اختارها من زر **Insert field** حتى تطلع بأسمائها الصحيحة.
   - Response mapping:
     `$.link` → city_link ، `$.house_no` → house_no ، `$.floors` → floors ، `$.is_new` → is_new ، `$.level_up` → level_up
   - اضغط **Test the request** وتأكد يرجع جواب.
٣. بعدها **Condition**:
   - إذا `is_new` = `yes` ← رسالة الترحيب (تحت).
   - وإلا إذا `level_up` = `yes` ← رسالة «بيتك كبر».
   - وإلا ← لا تدز شي (حتى ما تزعج اللي يعلّق هواية).
٤. الرسالة تكون **Private Reply** للتعليق، وحط الرابط كزر **Open website** يفتح `{{city_link}}`.

### ج. أتمتة «بيتي» (إذا ضيّع الرابط)
Trigger: **Keyword** بالدايركت = `بيتي` ← External Request على `/api/link` بنفس الهيدرز والبودي ← map `$.link` → city_link ← رسالة: «هذا رابط بيتك 🏠» + زر يفتح `{{city_link}}`.

---

## الرسائل (بغدادي)

**ترحيب بساكن جديد:**
> هلا بيك {{First Name}} 🏠
> تعليقك سوّالك بيت بـ«مدينة المتابعين»! بيتك رقم {{house_no}} صار جاهز وباسمك.
> ادخله من هنا، لوّنه على كيفك واكتب جملة على بابه 👇
> ⚠️ هذا الرابط مفتاح بيتك، لا تنطيه لأحد. وإذا ضيّعته دزلنا «بيتي».

**بيتك كبر:**
> عاشت إيدك {{First Name}}! من كثر تعليقاتك بيتك صعد طابق 🏗️
> هسه صار {{floors}} طوابق، تعال شوفه 👇

---

## إذا أحد كتب شي مسيء

تكدر تشيل بيته من Terminal:
```
curl -X POST https://رابط-مدينتك/api/admin/remove -H "x-city-secret: كلمة-السر" -H "content-type: application/json" -d '{"username":"اليوزر"}'
```

## ملاحظات
- انستغرام يسمح برسالة وحدة لكل تعليق، وخلال ٧ أيام من التعليق.
- اسم المدينة تغيّره من أول سطر بالسكربت داخل `public/index.html` (`CITY_NAME`).
- إذا فتحت `public/index.html` مباشرة من الكمبيوتر بدون سيرفر، تطلع مدينة تجريبية بأسماء وهمية.
