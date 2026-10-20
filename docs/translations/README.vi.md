# Home Studio — Bắt đầu nhanh

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=vi#native-studio) · [Languages](README.md)

## Bắt đầu trong Home Assistant

Với ngôi nhà mới, hãy dùng Home Studio bên trong Home Assistant. Không cần cài Python riêng, viết YAML hay tạo mã thông báo truy cập.

Nếu đã dùng thành phần được tạo sẵn hoặc tùy chỉnh, hãy đọc **Existing generated homes** trong hướng dẫn chi tiết trước: không có chuyển đổi tự động.

1. Dùng Home Assistant 2026.10 trở lên và tạo bản sao lưu.
2. Trong HACS, thêm `https://github.com/ha-homelab/home-studio` làm kho tùy chỉnh thuộc loại **Integration**. Cài bản ổn định của Home Studio có **home_floorplan.zip**, rồi khởi động lại Home Assistant.
3. Mở **Settings → Devices & services → Add integration → Home Studio**.
4. Dùng tài khoản quản trị viên để mở **Home Studio** ở thanh bên. Vẽ phòng và liên kết các vật dụng với thiết bị HA thực tế.
5. Nhấn **Save draft**, rồi **Publish family view**. Mở **3D Home** và kiểm tra liên kết bằng **Dry run** trước khi điều khiển thiết bị.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Tùy chọn: vẽ trong khi thiết lập HA

Bạn có thể dùng trình biên tập riêng trên trình duyệt khi đang chuẩn bị HA. Trình này không có kết nối trực tiếp với HA. Xuất JSON, sau đó dùng **Open JSON** trong Home Studio bên trong HA để mở, kiểm tra thiết bị, lưu và xuất bản.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=vi)

Vẽ ngôi nhà của bạn trong trình duyệt mà không cần tài khoản. Chọn ngôn ngữ ở đầu trình biên tập.

1. Thêm phòng, tường, cửa ra vào và cửa sổ. Thư viện có 206 mô hình. Chọn bảng màu và hoa văn bề mặt cho các vật dụng được hỗ trợ.
2. Xuất JSON để giữ bản sao có thể chỉnh sửa. Bản nháp chỉ được lưu trong trình duyệt này. Đổi ngôn ngữ không làm thay đổi sơ đồ.

### Tùy chọn: bộ công cụ di động và trình biên dịch Python

Quy trình này dành cho việc biên dịch riêng và các bản cài đặt được tạo trước đây; hãy bỏ qua khi cài mới theo cách tích hợp trực tiếp.

Tải xuống và giải nén bộ công cụ đầy đủ. Cài Python 3.10 trở lên. Chạy lệnh sau trong thư mục bộ công cụ:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Hướng dẫn cài đặt bằng tiếng Anh giải thích sao lưu, Home Assistant OS, đường dẫn cấu hình và khởi động lại. Trình biên tập trên trình duyệt không tự kết nối với Home Assistant hay điều khiển thiết bị.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=vi) · [README](../../README.md) · [i18n](../i18n.md)

Sơ đồ nhà và ID thực thể của thiết bị có thể là thông tin riêng tư. Hãy dùng ngôi nhà hư cấu làm ví dụ công khai.

Đây là hướng dẫn nhanh đã dịch. Tài liệu tham khảo đầy đủ và hướng dẫn có hình hiện bằng tiếng Anh. Chúng tôi hoan nghênh các sửa đổi bản dịch.

## Thử nút mà không gửi lệnh

Trong sơ đồ Home Assistant đã cài đặt, bật Dry run để thử các nút mà không gửi lệnh. Công tắc, nguồn TV, rèm và hộp thoại gốc có điều khiển khóa đều bị chặn; trạng thái vẫn là dữ liệu thực. Lưu địa chỉ sơ đồ với ?dry_run=1 vào dấu trang của trình duyệt này. Vẫn có thể lưu thay đổi bố cục.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
