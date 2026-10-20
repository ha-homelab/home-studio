<div dir="rtl">

# Home Studio — התחלה מהירה

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=he#native-studio) · [Languages](README.md)

## התחילו בתוך Home Assistant

לבית חדש, השתמשו ב־Home Studio בתוך Home Assistant. אין צורך בהתקנה נפרדת של Python, בכתיבת YAML או ביצירת אסימון גישה.

אם כבר מותקן רכיב שנוצר מראש או הותאם אישית, קראו תחילה את **Existing generated homes** במדריך המפורט; אין המרה אוטומטית.

1. השתמשו ב־Home Assistant 2026.10 ומעלה וצרו גיבוי.
2. ב־HACS, הוסיפו את `https://github.com/ha-homelab/home-studio` כמאגר מותאם אישית בקטגוריה **Integration**. התקינו גרסה יציבה של Home Studio הכוללת את **home_floorplan.zip**, ואז הפעילו מחדש את Home Assistant.
3. פתחו את **Settings → Devices & services → Add integration → Home Studio**.
4. באמצעות חשבון מנהל, פתחו את **Home Studio** בסרגל הצד. שרטטו חדר וקשרו את הפריטים למכשירי HA האמיתיים.
5. לחצו על **Save draft** ואז על **Publish family view**. פתחו את **3D Home** ובדקו את הקישורים באמצעות **Dry run** לפני שליטה במכשירים.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## אפשרות נוספת: שרטוט בזמן הגדרת HA

אפשר להשתמש בעורך הדפדפן הנפרד בזמן הכנת HA. אין לו חיבור חי ל־HA. ייצאו JSON, ואז פתחו אותו באמצעות **Open JSON** ב־Home Studio בתוך HA, בדקו את המכשירים, שמרו ופרסמו.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=he)

שרטטו את הבית בדפדפן. אין צורך בחשבון. בחרו את השפה בחלק העליון של העורך.

1. הוסיפו חדרים, קירות, דלתות וחלונות. הספרייה כוללת 206 דגמים. בחרו פלטת צבעים, ובפריטים נתמכים גם דוגמת משטח.
2. ייצאו JSON כדי לשמור עותק שניתן לערוך. טיוטות נשמרות רק בדפדפן הזה. החלפת השפה אינה משנה את התוכנית.

### אפשרות נוספת: ערכת כלים ניידת ומהדר Python

מסלול זה מיועד לבנייה נפרדת ולהתקנות קודמות שנוצרו באמצעות הכלים; דלגו עליו בהתקנה מובנית חדשה.

הורידו וחלצו את ערכת הכלים המלאה. התקינו Python 3.10 ומעלה. בתיקיית הכלים הריצו:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

מדריך ההתקנה באנגלית מסביר על גיבויים, Home Assistant OS, נתיב ההגדרות והפעלה מחדש. עורך הדפדפן עצמו אינו מתחבר ל־Home Assistant ואינו שולט במכשירים.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=he) · [README](../../README.md) · [i18n](../i18n.md)

תוכנית הבית ומזהי המכשירים עשויים להיות פרטיים. השתמשו בבית בדיוני בדוגמאות פומביות.

זהו מדריך התחלה מהירה מתורגם. התיעוד המלא והמדריך המאויר זמינים כעת באנגלית. נשמח לקבל תיקוני תרגום.

## ניסוי כפתורים ללא פקודות

בתוכנית המותקנת של Home Assistant, הפעילו Dry run כדי לנסות כפתורים בלי לשלוח פקודות. מתגים, הפעלת טלוויזיות, וילונות וחלונות מובנים עם בקרת מנעולים נחסמים; המצבים המוצגים נשארים אמיתיים. שמרו את כתובת התוכנית עם ?dry_run=1 בסימניות של הדפדפן הזה. עדיין ניתן לשמור שינויים במיקום הפריטים.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)

</div>
