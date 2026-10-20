<div dir="rtl">

# Home Studio — البدء السريع

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=ar#native-studio) · [Languages](README.md)

## ابدأ داخل Home Assistant

لمنزل جديد، استخدم Home Studio داخل Home Assistant. لا تحتاج إلى تثبيت Python بشكل منفصل أو كتابة YAML أو إنشاء رمز وصول.

إذا كنت تستخدم مكوّنًا مولّدًا أو مخصصًا من قبل، فاقرأ أولًا **Existing generated homes** في الدليل المفصل؛ فلا يوجد تحويل تلقائي.

1. استخدم Home Assistant 2026.10 أو أحدث وأنشئ نسخة احتياطية.
2. في HACS، أضف `https://github.com/ha-homelab/home-studio` كمستودع مخصص من فئة **Integration**. ثبّت الإصدار المستقر من Home Studio الذي يتضمن **home_floorplan.zip**، ثم أعد تشغيل Home Assistant.
3. افتح **Settings → Devices & services → Add integration → Home Studio**.
4. بحساب مسؤول، افتح **Home Studio** من الشريط الجانبي. ارسم غرفة واربط العناصر بأجهزة HA الحقيقية.
5. اضغط **Save draft** ثم **Publish family view**. افتح **3D Home** وتحقق من ربط الأجهزة باستخدام **Dry run** قبل التحكم بها.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## اختياري: الرسم أثناء إعداد HA

يمكن استخدام محرر المتصفح المنفصل أثناء تجهيز HA. ليس لديه اتصال مباشر بـHA. صدّر JSON، ثم افتحه باستخدام **Open JSON** في Home Studio داخل HA، وتحقق من الأجهزة واحفظ وانشر.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=ar)

ارسم منزلك في المتصفح دون الحاجة إلى حساب. اختر لغتك من أعلى المحرر.

1. أضف الغرف والجدران والأبواب والنوافذ. تضم المكتبة 206 نموذجًا. اختر لوحة ألوان، ونمطًا للسطح في العناصر التي تدعم ذلك.
2. صدّر ملف JSON للاحتفاظ بنسخة قابلة للتحرير. تبقى المسودات في هذا المتصفح فقط. تغيير اللغة لا يغيّر مخططك.

### اختياري: مجموعة الأدوات المحمولة ومترجم Python

هذا المسار مخصص للبناء المنفصل وعمليات التثبيت المولّدة السابقة؛ تجاوزه عند إجراء تثبيت أصلي جديد داخل HA.

نزّل مجموعة الأدوات الكاملة وفك ضغطها. ثبّت Python 3.10 أو أحدث. نفّذ الأمر التالي داخل مجلد الأدوات:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

يوضح دليل التثبيت باللغة الإنجليزية النسخ الاحتياطي وHome Assistant OS ومسار الإعدادات وإعادة التشغيل. محرر المتصفح نفسه لا يتصل بـHome Assistant ولا يتحكم بالأجهزة.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=ar) · [README](../../README.md) · [i18n](../i18n.md)

قد يكون مخطط منزلك ومعرّفات الأجهزة معلومات خاصة. استخدم منزلًا خياليًا للأمثلة المنشورة للعامة.

هذا دليل بدء سريع مترجم. الوثائق الكاملة والدليل المصوّر متاحان حاليًا بالإنجليزية. نرحب بتصحيحات الترجمة.

## تجربة الأزرار دون أوامر

في مخطط Home Assistant المثبت، فعّل Dry run لتجربة الأزرار دون إرسال أوامر. تُحجب المفاتيح وطاقة التلفاز والستائر والنوافذ الأصلية التي تحتوي على تحكم بالأقفال؛ وتظل الحالات المعروضة حقيقية. احفظ عنوان المخطط مع ?dry_run=1 في إشارات هذا المتصفح لتثبيت الوضع. يظل حفظ تعديلات توزيع العناصر ممكنًا.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)

</div>
