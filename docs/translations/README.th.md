# Home Studio — เริ่มต้นอย่างรวดเร็ว

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=th) · [Languages](README.md)

วาดแปลนบ้านในเบราว์เซอร์โดยไม่ต้องมีบัญชี เลือกภาษาที่ด้านบนของตัวแก้ไข

1. เพิ่มห้อง ผนัง ประตู และหน้าต่าง คลังมีโมเดล 195 แบบ เลือกชุดสีและลวดลายพื้นผิวสำหรับวัตถุที่รองรับ
2. ส่งออก JSON เพื่อเก็บสำเนาที่แก้ไขได้ แบบร่างจะอยู่ในเบราว์เซอร์นี้เท่านั้น การเปลี่ยนภาษาไม่เปลี่ยนแปลนของคุณ

ดาวน์โหลดและแตกไฟล์ชุดเครื่องมือทั้งหมด ติดตั้ง Python 3.10 หรือใหม่กว่า จากโฟลเดอร์ชุดเครื่องมือ ให้รัน:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

คู่มือติดตั้งภาษาอังกฤษอธิบายการสำรองข้อมูล Home Assistant OS ตำแหน่งการตั้งค่า และการเริ่มระบบใหม่ ตัวแก้ไขในเบราว์เซอร์ไม่ได้เชื่อมต่อกับ Home Assistant หรือควบคุมอุปกรณ์โดยตรง

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=th) · [README](../../README.md) · [i18n](../i18n.md)

แปลนบ้านและ ID เอนทิตีของอุปกรณ์อาจเป็นข้อมูลส่วนตัว ควรใช้บ้านสมมติเป็นตัวอย่างที่เผยแพร่ต่อสาธารณะ

นี่คือคู่มือเริ่มต้นฉบับแปล เอกสารอ้างอิงฉบับเต็มและคู่มือภาพประกอบยังเป็นภาษาอังกฤษ ยินดีรับการแก้ไขคำแปล

MIT · [LICENSE](../../LICENSE)
