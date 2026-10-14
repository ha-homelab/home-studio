<div dir="rtl">

# Home Studio — شروع سریع

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=fa) · [Languages](README.md)

خانهٔ خود را در مرورگر ترسیم کنید. نیازی به حساب کاربری نیست. زبان را از بالای ویرایشگر انتخاب کنید.

1. اتاق، دیوار، در و پنجره اضافه کنید. کتابخانه شامل 195 مدل است. پالت رنگ و برای اشیای پشتیبانی‌شده طرح سطح را انتخاب کنید.
2. برای نگهداری نسخهٔ قابل ویرایش، JSON را صادر کنید. پیش‌نویس‌ها فقط در همین مرورگر ذخیره می‌شوند. تغییر زبان نقشه را تغییر نمی‌دهد.

بستهٔ کامل ابزارها را دانلود و استخراج کنید. Python 3.10 یا جدیدتر را نصب کنید. در پوشهٔ ابزارها اجرا کنید:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

راهنمای نصب انگلیسی، پشتیبان‌گیری، Home Assistant OS، مسیر تنظیمات و راه‌اندازی مجدد را توضیح می‌دهد. ویرایشگر مرورگر به‌خودی‌خود به Home Assistant متصل نمی‌شود و دستگاه‌ها را کنترل نمی‌کند.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

نقشهٔ خانه و شناسه‌های دستگاه‌ها ممکن است خصوصی باشند. برای نمونه‌های عمومی از خانه‌ای خیالی استفاده کنید.

این راهنمای شروع سریع ترجمه‌شده است. مستندات کامل و راهنمای تصویری فعلاً انگلیسی هستند. از اصلاح ترجمه‌ها استقبال می‌کنیم.

MIT · [LICENSE](../../LICENSE)

</div>
