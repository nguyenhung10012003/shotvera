# Phân tích ngược iScreen Shoter 3.0.2 (macOS)

> Mục đích: lấy **đặc tả chức năng** để làm app riêng (Shotvera) theo hướng *clean-room*.
> Chỉ dùng tài liệu này như đặc tả hành vi. **Không** sao chép code, icon, ảnh emoji, animation Lottie hay tên thương hiệu của app gốc.

Công cụ dùng: `rea` 6.8.0 (`inspect-desktop-application`, `decode-interface-builder`, `inspect-asset-catalog`), `otool -ov` (metadata ObjC/Swift), `nm -u` (API hệ thống được import), dump section `__swift5_reflstr` (tên field và case của enum), `plutil` (chuỗi giao diện).
Binary đã bị strip và trên máy chưa có engine decompile (Hopper/Ghidra/IDA), nên đây là **phân tích tĩnh mức kiến trúc và hành vi**, không có pseudocode.
Dữ liệu gốc nằm trong `evidence/`.

---

## 1. Tổng quan

| Mục | Giá trị |
|---|---|
| Bundle ID | `com.screenshot.iscreenshoter` (App Store id 1596559494) |
| Phiên bản | 3.0.2 (build 28), Xcode 15, SDK macOS 14, tối thiểu macOS 10.15 |
| Kiến trúc | Universal (x86_64 + arm64), Swift + AppKit (+ một ít SwiftUI) |
| Kiểu app | Chỉ chạy ở menu bar (`LSUIElement = true`), không có icon Dock |
| URL scheme | `iScreenShoter://`, `iScreenShoterSelfStart://` |
| Helper | `Library/LoginItems/VideoRecrdingHelper.app` (dùng cho login item và ghi hình) |
| Ngôn ngữ giao diện | en, de, es, fr, ja, ru, zh-Hans |

### Thư viện bên thứ ba
- **HotKey**: phím tắt toàn cục (Carbon)
- **SnapKit**: Auto Layout
- **Lottie**: animation loading
- **Alamofire, SwiftyJSON**: mạng
- **SwiftyStoreKit**: mua gói thuê bao (IAP)
- **Firebase Core/Crashlytics, Google Analytics**: báo crash và theo dõi sử dụng

### API hệ thống dùng (lấy từ `nm -u`)
| Chức năng | API |
|---|---|
| Chụp ảnh màn hình | `CGWindowListCreateImage`, `CGDisplayCreateImage` (API cũ, chưa dùng ScreenCaptureKit) |
| Nhận diện cửa sổ dưới chuột | `CGWindowListCopyWindowInfo` |
| Quyền ghi màn hình | `CGPreflightScreenCaptureAccess`, kèm màn hình hướng dẫn 7 bước |
| OCR | Vision `VNRecognizeTextRequest`, `supportedRecognitionLanguages…` |
| Mosaic | `CIFilter` (CoreImage, nhiều khả năng là pixellate) |
| Ghi màn hình | `AVCaptureSession`, `AVCaptureScreenInput`, `AVAssetWriter` + `PixelBufferAdaptor` |
| Chạy khi đăng nhập | `SMLoginItemSetEnabled` |
| Chia sẻ | `NSSharingServicePicker` (AirDrop, Mail…) |
| Kéo thả ảnh ra app khác | `NSDraggingSource`, `NSPasteboardItemDataProvider` |

---

## 2. Danh sách tính năng (đã đối chiếu storyboard, enum và chuỗi giao diện)

### 2.1 Menu bar / màn hình chính (`VRScreenHotStatusHomeViewController`)
- Popover từ icon menu bar, gồm các nút: **Screenshot**, **OCR (Picture To Text)**, **Record screen**, Open folder, Settings, Feedback, Share App, WeChat, Purchase.
- **Lưới lịch sử ảnh chụp** (`NSCollectionView`): click để xem lớn, kéo ảnh ra app khác, xóa.
- Xem ảnh lớn (`VRScreenHotBigPreviewViewController`): Copy / Delete / Show in Finder.

### 2.2 Chọn vùng chụp (`VRScreenCaptureViewController`, `VRCutScreenView`)
- Phủ lớp mờ toàn màn hình, kéo chuột để chọn vùng.
- **Tự nhận diện cửa sổ** khi rê chuột (`VRWindowInfo`: bounds, ownerPID, windowId, windowName, ownerName, alpha).
- **8 tay nắm + kéo giữa** để chỉnh vùng chọn (`top_middle, left_middle, right_middle, bottom_middle, left_top, let_bottom, right_top, right_bottom, center`). Viền nét đứt (`dottedBoxLayer`).
- **Kính lúp + lấy màu** (`VRViewMagnifier`: `imageScale`, `colorHex`, `pointInfoLabel` hiển thị tọa độ và mã màu HEX).
- **Nhập chính xác width/height** cho vùng chọn (`VRScreenCaptureSetupToolController`).
- Ba chế độ dùng chung màn chọn vùng: `screenCaptureType ∈ { image, ocr, video }`.
- Con trỏ tùy biến theo hướng (`icon_cursor_0/45/90/135`, `move_cursor`).

### 2.3 Thanh công cụ chú thích (`VRScreenHotToolViewController`)
Enum công cụ: `none, rectangle, ellipse, line, arrow, words, open, text, mosaic`

| Công cụ | Class | Ghi chú |
|---|---|---|
| Rectangle | `VRRectangleView` | `lineWidth`, `strokeColor`, di chuyển/chọn lại được (`select`, `isMove`) |
| Oval | `VREllipseView` | như Rectangle |
| Line | `VRLineShapeLayer` | |
| Arrow | `VRArrowView` | `directionType`, `lineWidth`, `strokeColor` |
| Pen (vẽ tự do) | `VROpenShapeLayer` (`open`) | |
| Text | `VRTextFieldView`, `ResizingTextField` | ô chữ tự giãn |
| Mosaic | `VRMosaicView` + `mosaicViewMask` | tô để làm mờ, có `mosaicLineWidth` |
| Emoji/Sticker | `VREmoteViewModel` | 24 emoji PNG có sẵn |
| Add Image (Import) | `imageImport:` | chèn ảnh khác vào canvas |
| Undo | `revokeButton` | Redo có icon nhưng không rõ đã nối vào action chưa |

- **Bảng cấu hình nét vẽ** (`VRGraffitiConfigurationViewController`): hàng màu (`colorStackView`) + slider độ dày (`VRSlider`: min/max).
- Các action khác trên thanh: **OCR**, **Translate**, **Pin**, **Record**, **Share**, **Save** (Save / Quick Save, chọn qua `VRSaveModeSelectionView`), **OK/Copy (⌘⏎)**, **Close (Esc)**.
- Phím tắt: ⌘S lưu, ⌘C copy, ⌘⏎ copy và đóng, Esc thoát.

### 2.4 Pin ảnh nổi trên màn hình (`VRScreenHotPreviewViewController`)
- Cửa sổ nổi luôn ở trên cùng (`thumbtack`), có Close/Save/Delete.
- Thu phóng: `custom, scale_50, scale_100, scale_200`; có thanh kéo để di chuyển (`_barDragShow`).
- Kéo ảnh ra app khác (`VRPreviewDraggingView`).

### 2.5 Lưu file (`VRSaveViewController`)
- Định dạng: **JPG / PNG / PDF**; đặt tên file (báo lỗi khi tên trống hoặc đã tồn tại); chọn thư mục lưu; nút Open Folder.
- Quick Save: lưu ngay vào thư mục mặc định, không hỏi.

### 2.6 OCR (`VROCRViewController` + `GlobalStatus`)
- Vision OCR, **chọn ngôn ngữ nhận diện** (`langCodes`, `langStrings`).
- Tùy chọn **"Optimise OCR results for tables"** (`_resultForTables`).
- Trạng thái: `none → loading → complete`, có lỗi "Text recognition failed!". Có nút Copy.
- **Chuyển cho AI (Sider)**: `explain, translate, summarize, Q_A, grammar, explainCodes, rewrite, formatting`. App gốc không tự gọi LLM, chỉ deep-link sang app Sider (`sider.ai/mac`) và kiểm tra Sider đã cài và đủ phiên bản chưa.

### 2.7 Ghi màn hình (`VRMediaCapturer`, `VRScreenhotRecording`, `RecordWindow`)
- Ghi theo vùng (`cropRect`) hoặc theo cửa sổ (`currentWindowId`); có thể thu thêm camera/mic.
- Hai đường ghi: `AVCaptureScreenInput` → file, hoặc chụp từng frame → `AVAssetWriter` (`minFrameDuration`).

### 2.8 Cài đặt (`VRSettingViewController`), các tab `general, shortcuts, about`
- Thư mục lưu ảnh, Open at login.
- Hai phím tắt toàn cục có thể đổi: **Screenshot** và **OCR** (key `AppDelegate_screenHotKeysSaveKey`, `AppDelegate_ocrHotKeysSaveKey`), kèm cảnh báo khi trùng phím.
- Version, Privacy, Terms, Feedback.

### 2.9 Khác
- Quyền ghi màn hình: kiểm tra định kỳ (`screenPermissionCheckTimer`) và hướng dẫn mở System Settings, nút "Finished & Reload It".
- Thông báo có bản mới (so phiên bản qua iTunes lookup), xin đánh giá (`VRRequestReview`).
- Thuê bao theo tháng (StoreKit), Restore Purchase.

---

## 3. Giao diện / phong cách
- Nền tối: `#1C1C1C, #262626, #2C2C2C, #323232, #363636, #3A3A3A, #484848`.
- Màu nhấn: xanh `#55B1FF`, tím `#8A57EA`, xanh chanh `#E7FE66`.
- Thanh công cụ nằm ngang, nổi dưới vùng chọn; icon line đơn sắc.

---

## 4. Luồng chính (dựng lại từ class và action)

```
Hotkey / menu bar
   └─▶ Phủ overlay trên mọi màn hình (VRCutScreenWindow)
         ├─ rê chuột: highlight cửa sổ dưới con trỏ + kính lúp + mã màu
         ├─ kéo chuột: tạo vùng chọn → 8 tay nắm chỉnh sửa, nhập W×H
         └─ thả chuột: hiện thanh công cụ
               ├─ chú thích: rect/oval/line/arrow/pen/text/mosaic/emoji/import + undo
               ├─ OCR ─▶ cửa sổ OCR ─▶ copy / gửi AI
               ├─ Translate, Pin (cửa sổ nổi), Record (ghi vùng chọn)
               ├─ Share (NSSharingServicePicker)
               ├─ Save (hộp thoại JPG/PNG/PDF) | Quick Save
               └─ OK / ⌘⏎ ─▶ copy clipboard + lưu lịch sử + toast "Copied"
```

---

## 5. Những điểm Shotvera có thể làm tốt hơn
1. **Đa nền tảng** (macOS, Windows, Linux); app gốc chỉ chạy trên macOS.
2. **ScreenCaptureKit** trên macOS 12.3+ (`CGWindowListCreateImage` đã bị deprecate ở macOS 14/15).
3. **AI tích hợp sẵn** thay vì đẩy sang app ngoài:
   - Chat với ảnh (vision LLM): hỏi đáp, giải thích, dịch, tóm tắt, trích bảng.
   - **Sửa ảnh bằng lời**: "che hết email", "khoanh đỏ nút Submit", "làm mờ khuôn mặt". AI trả về các lệnh chú thích có cấu trúc, áp lên canvas, sửa tay lại được.
   - Tạo hoặc biến đổi ảnh (image generation/edit model).
   - Tự động làm mờ thông tin nhạy cảm (PII).
4. Redo, scrolling capture, chụp có delay, chú thích dạng bước (1, 2, 3), highlighter, blur (ngoài mosaic). App gốc chưa có các tính năng này.

---

## 6. Tệp evidence
| File | Nội dung |
|---|---|
| `evidence/desktop-app.json` | REA desktop inspection (evidence bundle) |
| `evidence/interface-builder.json` | REA decode 31 storyboard/nib (graph đầy đủ) |
| `evidence/ib-summary.txt` | Tóm tắt từng màn: class, outlet, action |
| `evidence/objc-metadata.txt` | `otool -ov` arm64 |
| `evidence/classes.txt` | 68 class Swift của app |
| `evidence/class-members.txt` | ivars/methods theo class |
| `evidence/strings-en.txt` | 102 chuỗi giao diện tiếng Anh |
| `evidence/asset-catalog.json` | REA asset catalog (tên icon và màu) |
