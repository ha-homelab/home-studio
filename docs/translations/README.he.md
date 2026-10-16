<div dir="rtl">

# Home Studio — התחלה מהירה

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=he) · [Languages](README.md)

שרטטו את הבית בדפדפן. אין צורך בחשבון. בחרו את השפה בחלק העליון של העורך.

1. הוסיפו חדרים, קירות, דלתות וחלונות. הספרייה כוללת 195 דגמים. בחרו פלטת צבעים, ובפריטים נתמכים גם דוגמת משטח.
2. ייצאו JSON כדי לשמור עותק שניתן לערוך. טיוטות נשמרות רק בדפדפן הזה. החלפת השפה אינה משנה את התוכנית.

הורידו וחלצו את ערכת הכלים המלאה. התקינו Python 3.10 ומעלה. בתיקיית הכלים הריצו:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

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
