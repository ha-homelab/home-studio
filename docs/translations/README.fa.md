<div dir="rtl">

# Home Studio — شروع سریع

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=fa#native-studio) · [Languages](README.md)

## از داخل Home Assistant شروع کنید

برای خانه‌ای جدید، از Home Studio درون Home Assistant استفاده کنید. به نصب جداگانهٔ Python، نوشتن YAML یا ساخت توکن دسترسی نیازی نیست.

اگر از قبل مؤلفه‌ای تولیدشده یا سفارشی دارید، ابتدا بخش **Existing generated homes** را در راهنمای کامل بخوانید؛ تبدیل خودکار انجام نمی‌شود.

1. از Home Assistant 2026.10 یا جدیدتر استفاده کنید و نسخهٔ پشتیبان بگیرید.
2. در HACS، نشانی `https://github.com/ha-homelab/home-studio` را به‌عنوان مخزن سفارشی با دستهٔ **Integration** اضافه کنید. نسخهٔ پایدار Home Studio شامل **home_floorplan.zip** را نصب و Home Assistant را دوباره راه‌اندازی کنید.
3. **Settings → Devices & services → Add integration → Home Studio** را باز کنید.
4. با حساب مدیر، **Home Studio** را از نوار کناری باز کنید. یک اتاق بکشید و اشیا را به دستگاه‌های واقعی HA پیوند دهید.
5. **Save draft** و سپس **Publish family view** را بزنید. **3D Home** را باز کنید و پیش از کنترل دستگاه‌ها، پیوندها را با **Dry run** بررسی کنید.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## اختیاری: طراحی هنگام آماده‌سازی HA

هنگام آماده‌سازی HA می‌توانید از ویرایشگر جداگانهٔ مرورگر استفاده کنید. این ویرایشگر اتصال زنده‌ای به HA ندارد. JSON را صادر کنید و سپس با **Open JSON** در Home Studio داخل HA باز کنید، دستگاه‌ها را بررسی و طرح را ذخیره و منتشر کنید.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=fa)

خانهٔ خود را در مرورگر ترسیم کنید. نیازی به حساب کاربری نیست. زبان را از بالای ویرایشگر انتخاب کنید.

1. اتاق، دیوار، در و پنجره اضافه کنید. کتابخانه شامل 206 مدل است. پالت رنگ و برای اشیای پشتیبانی‌شده طرح سطح را انتخاب کنید.
2. برای نگهداری نسخهٔ قابل ویرایش، JSON را صادر کنید. پیش‌نویس‌ها فقط در همین مرورگر ذخیره می‌شوند. تغییر زبان نقشه را تغییر نمی‌دهد.

### اختیاری: ابزارهای قابل‌حمل و کامپایلر Python

این مسیر برای ساخت جداگانه و نصب‌های تولیدشدهٔ قبلی است؛ برای نصب بومی جدید آن را رد کنید.

بستهٔ کامل ابزارها را دانلود و استخراج کنید. Python 3.10 یا جدیدتر را نصب کنید. در پوشهٔ ابزارها اجرا کنید:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

راهنمای نصب انگلیسی، پشتیبان‌گیری، Home Assistant OS، مسیر تنظیمات و راه‌اندازی مجدد را توضیح می‌دهد. ویرایشگر مرورگر به‌خودی‌خود به Home Assistant متصل نمی‌شود و دستگاه‌ها را کنترل نمی‌کند.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=fa) · [README](../../README.md) · [i18n](../i18n.md)

نقشهٔ خانه و شناسه‌های دستگاه‌ها ممکن است خصوصی باشند. برای نمونه‌های عمومی از خانه‌ای خیالی استفاده کنید.

این راهنمای شروع سریع ترجمه‌شده است. مستندات کامل و راهنمای تصویری فعلاً انگلیسی هستند. از اصلاح ترجمه‌ها استقبال می‌کنیم.

## آزمایش دکمه‌ها بدون فرمان

در نقشهٔ نصب‌شدهٔ Home Assistant، برای آزمایش دکمه‌ها بدون ارسال فرمان، Dry run را روشن کنید. کلیدها، برق تلویزیون، پرده‌ها و پنجره‌های اصلی دارای کنترل قفل مسدود می‌شوند؛ وضعیت‌ها همچنان واقعی هستند. نشانی نقشه را با ?dry_run=1 در نشانک‌های همین مرورگر ذخیره کنید. تغییرات چیدمان همچنان قابل ذخیره هستند.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)

</div>
