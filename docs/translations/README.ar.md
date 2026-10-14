<div dir="rtl">

# Home Studio — البدء السريع

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=ar) · [Languages](README.md)

ارسم منزلك في المتصفح دون الحاجة إلى حساب. اختر لغتك من أعلى المحرر.

1. أضف الغرف والجدران والأبواب والنوافذ. تضم المكتبة 195 نموذجًا. اختر لوحة ألوان، ونمطًا للسطح في العناصر التي تدعم ذلك.
2. صدّر ملف JSON للاحتفاظ بنسخة قابلة للتحرير. تبقى المسودات في هذا المتصفح فقط. تغيير اللغة لا يغيّر مخططك.

نزّل مجموعة الأدوات الكاملة وفك ضغطها. ثبّت Python 3.10 أو أحدث. نفّذ الأمر التالي داخل مجلد الأدوات:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

يوضح دليل التثبيت باللغة الإنجليزية النسخ الاحتياطي وHome Assistant OS ومسار الإعدادات وإعادة التشغيل. محرر المتصفح نفسه لا يتصل بـHome Assistant ولا يتحكم بالأجهزة.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

قد يكون مخطط منزلك ومعرّفات الأجهزة معلومات خاصة. استخدم منزلًا خياليًا للأمثلة المنشورة للعامة.

هذا دليل بدء سريع مترجم. الوثائق الكاملة والدليل المصوّر متاحان حاليًا بالإنجليزية. نرحب بتصحيحات الترجمة.

MIT · [LICENSE](../../LICENSE)

</div>
