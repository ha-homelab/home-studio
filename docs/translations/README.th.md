# Home Studio — เริ่มต้นอย่างรวดเร็ว

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=th#native-studio) · [Languages](README.md)

## เริ่มต้นใน Home Assistant

สำหรับบ้านใหม่ ให้ใช้ Home Studio ภายใน Home Assistant โดยไม่ต้องติดตั้ง Python แยก เขียน YAML หรือสร้างโทเค็นเข้าถึง

หากใช้คอมโพเนนต์ที่สร้างไว้หรือปรับแต่งไว้แล้ว ให้อ่าน **Existing generated homes** ในคู่มือฉบับเต็มก่อน เพราะไม่มีการแปลงให้อัตโนมัติ

1. ใช้ Home Assistant 2026.10 หรือใหม่กว่า และสำรองข้อมูลก่อน
2. ใน HACS ให้เพิ่ม `https://github.com/ha-homelab/home-studio` เป็นที่เก็บแบบกำหนดเองในหมวด **Integration** ติดตั้ง Home Studio รุ่นเสถียรที่มี **home_floorplan.zip** แล้วเริ่ม Home Assistant ใหม่
3. เปิด **Settings → Devices & services → Add integration → Home Studio**
4. ใช้บัญชีผู้ดูแลระบบเปิด **Home Studio** ในแถบด้านข้าง วาดห้องและเชื่อมโยงวัตถุกับอุปกรณ์จริงของ HA
5. กด **Save draft** แล้วกด **Publish family view** เปิด **3D Home** และตรวจสอบการเชื่อมโยงด้วย **Dry run** ก่อนควบคุมอุปกรณ์

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## ทางเลือก: วาดแปลนระหว่างตั้งค่า HA

ใช้ตัวแก้ไขในเบราว์เซอร์ที่แยกต่างหากได้ระหว่างเตรียม HA ตัวแก้ไขนี้ไม่มีการเชื่อมต่อแบบสดกับ HA ส่งออก JSON แล้วเปิดด้วย **Open JSON** ใน Home Studio ภายใน HA จากนั้นตรวจสอบอุปกรณ์ บันทึก และเผยแพร่

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=th)

วาดแปลนบ้านในเบราว์เซอร์โดยไม่ต้องมีบัญชี เลือกภาษาที่ด้านบนของตัวแก้ไข

1. เพิ่มห้อง ผนัง ประตู และหน้าต่าง คลังมีโมเดล 206 แบบ เลือกชุดสีและลวดลายพื้นผิวสำหรับวัตถุที่รองรับ
2. ส่งออก JSON เพื่อเก็บสำเนาที่แก้ไขได้ แบบร่างจะอยู่ในเบราว์เซอร์นี้เท่านั้น การเปลี่ยนภาษาไม่เปลี่ยนแปลนของคุณ

### ทางเลือก: ชุดเครื่องมือแบบพกพาและคอมไพเลอร์ Python

ขั้นตอนนี้ใช้สำหรับการสร้างแยกและการติดตั้งที่สร้างไว้ก่อนหน้านี้ ให้ข้ามขั้นตอนนี้สำหรับการติดตั้งแบบเนทีฟใหม่

ดาวน์โหลดและแตกไฟล์ชุดเครื่องมือทั้งหมด ติดตั้ง Python 3.10 หรือใหม่กว่า จากโฟลเดอร์ชุดเครื่องมือ ให้รัน:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

คู่มือติดตั้งภาษาอังกฤษอธิบายการสำรองข้อมูล Home Assistant OS ตำแหน่งการตั้งค่า และการเริ่มระบบใหม่ ตัวแก้ไขในเบราว์เซอร์ไม่ได้เชื่อมต่อกับ Home Assistant หรือควบคุมอุปกรณ์โดยตรง

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=th) · [README](../../README.md) · [i18n](../i18n.md)

แปลนบ้านและ ID เอนทิตีของอุปกรณ์อาจเป็นข้อมูลส่วนตัว ควรใช้บ้านสมมติเป็นตัวอย่างที่เผยแพร่ต่อสาธารณะ

นี่คือคู่มือเริ่มต้นฉบับแปล เอกสารอ้างอิงฉบับเต็มและคู่มือภาพประกอบยังเป็นภาษาอังกฤษ ยินดีรับการแก้ไขคำแปล

## ทดลองปุ่มโดยไม่ส่งคำสั่ง

ในแผนผัง Home Assistant ที่ติดตั้งแล้ว ให้เปิด Dry run เพื่อทดลองปุ่มโดยไม่ส่งคำสั่ง สวิตช์ การเปิดปิดทีวี ม่าน และหน้าต่างของระบบที่มีตัวควบคุมล็อกจะถูกบล็อก แต่สถานะที่แสดงยังเป็นข้อมูลจริง บันทึกที่อยู่แผนผังพร้อม ?dry_run=1 เป็นบุ๊กมาร์กในเบราว์เซอร์นี้เพื่อคงโหมดไว้ ยังสามารถบันทึกการเปลี่ยนตำแหน่งวัตถุได้

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
