# Home Studio — Bắt đầu nhanh

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=vi) · [Languages](README.md)

Vẽ ngôi nhà của bạn trong trình duyệt mà không cần tài khoản. Chọn ngôn ngữ ở đầu trình biên tập.

1. Thêm phòng, tường, cửa ra vào và cửa sổ. Thư viện có 195 mô hình. Chọn bảng màu và hoa văn bề mặt cho các vật dụng được hỗ trợ.
2. Xuất JSON để giữ bản sao có thể chỉnh sửa. Bản nháp chỉ được lưu trong trình duyệt này. Đổi ngôn ngữ không làm thay đổi sơ đồ.

Tải xuống và giải nén bộ công cụ đầy đủ. Cài Python 3.10 trở lên. Chạy lệnh sau trong thư mục bộ công cụ:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Hướng dẫn cài đặt bằng tiếng Anh giải thích sao lưu, Home Assistant OS, đường dẫn cấu hình và khởi động lại. Trình biên tập trên trình duyệt không tự kết nối với Home Assistant hay điều khiển thiết bị.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

Sơ đồ nhà và ID thực thể của thiết bị có thể là thông tin riêng tư. Hãy dùng ngôi nhà hư cấu làm ví dụ công khai.

Đây là hướng dẫn nhanh đã dịch. Tài liệu tham khảo đầy đủ và hướng dẫn có hình hiện bằng tiếng Anh. Chúng tôi hoan nghênh các sửa đổi bản dịch.

MIT · [LICENSE](../../LICENSE)
