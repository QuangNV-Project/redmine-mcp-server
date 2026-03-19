# 🔴 Redmine MCP Server

MCP (Model Context Protocol) server cho phép Cursor / Claude đọc tickets từ Redmine và tự động tạo git branch tương ứng.

---

## ✨ Tính năng

| Tool | Mô tả |
|------|-------|
| `get_issue` | Đọc chi tiết 1 ticket (mô tả, status, comment history…) |
| `list_issues` | Liệt kê tickets (filter theo project, status, người được giao) |
| `list_projects` | Liệt kê tất cả projects |
| `update_issue_status` | Cập nhật trạng thái ticket |
| `add_comment` | Thêm comment vào ticket |
| `get_issue_statuses` | Xem danh sách các status có sẵn |
| `create_branch_for_issue` | ⭐ Đọc ticket → tự động tạo & checkout git branch |
| `git_current_branch` | Xem branch hiện tại |
| `git_list_branches` | Liệt kê tất cả local branches |

---

## 🚀 Cài đặt

### 1. Clone / tải project

```bash
git clone <repo> redmine-mcp
cd redmine-mcp
npm install
npm run build
```

### 2. Cấu hình biến môi trường

Copy file mẫu và điền thông tin:

```bash
cp .env.example .env
```

Chỉnh sửa `.env`:

```env
# URL Redmine của bạn (không có dấu / ở cuối)
REDMINE_URL=https://redmine.yourcompany.com

# API Key: vào Redmine → My account → API access key
REDMINE_API_KEY=abcdef1234567890abcdef1234567890

# (Tùy chọn) Đường dẫn đến repo local
GIT_REPO_PATH=/Users/yourname/projects/my-project

# Định dạng tên branch: ticket-id | ticket-id-title
BRANCH_FORMAT=ticket-id-title
```

---

## ⚙️ Tích hợp với Cursor

### Bước 1: Mở Cursor Settings

`Cmd/Ctrl + Shift + P` → tìm **"Open MCP Settings"** (hoặc vào **Settings → MCP**)

### Bước 2: Thêm config

Mở file `~/.cursor/mcp.json` (hoặc theo Cursor chỉ định) và thêm:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/redmine-mcp/dist/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.yourcompany.com",
        "REDMINE_API_KEY": "your_api_key_here",
        "GIT_REPO_PATH": "/path/to/your/project",
        "BRANCH_FORMAT": "ticket-id-title"
      }
    }
  }
}
```

> ⚠️ Thay `/ABSOLUTE/PATH/TO/redmine-mcp` bằng đường dẫn thực tế trên máy bạn.

### Bước 3: Restart Cursor

Sau khi lưu config, restart Cursor để MCP server được load.

---

## 💡 Cách dùng trong Cursor

Mở **Cursor Chat** (Agent mode) và gõ tự nhiên:

```
Đọc ticket #1234 cho tôi
```

```
Tạo branch cho ticket #1234 trong repo /Users/me/projects/backend
```

```
Liệt kê tất cả issues đang open của project my-project
```

```
Cập nhật ticket #1234 sang status "In Progress"
```

```
Thêm comment vào ticket #1234: "Đã fix xong, chờ review"
```

---

## 🌿 Quy tắc đặt tên branch

Với `BRANCH_FORMAT=ticket-id-title` (mặc định):

| Ticket | Subject | Branch được tạo |
|--------|---------|----------------|
| #1234 | Fix login bug on mobile | `feature/1234-fix-login-bug-on-mobile` |
| #567 | Thêm tính năng export PDF | `feature/567-them-tinh-nang-export-pdf` |

Với `BRANCH_FORMAT=ticket-id`:

| Ticket | Branch được tạo |
|--------|----------------|
| #1234 | `feature/1234` |

Bạn có thể chỉ định prefix khác khi dùng tool:
- `prefix: "fix"` → `fix/1234-...`
- `prefix: "hotfix"` → `hotfix/1234-...`
- `prefix: "chore"` → `chore/1234-...`

---

## 📁 Cấu trúc project

```
redmine-mcp/
├── src/
│   ├── index.ts          # MCP server chính, định nghĩa tất cả tools
│   ├── redmine-client.ts # Redmine REST API client
│   └── git-helper.ts     # Các hàm thao tác git
├── dist/                 # Output sau khi build (chạy npm run build)
├── .env.example          # Mẫu biến môi trường
├── cursor-mcp-config.json # Config mẫu cho Cursor
├── package.json
└── tsconfig.json
```

---

## 🔑 Lấy API Key Redmine

1. Đăng nhập Redmine
2. Click vào tên của bạn ở góc phải trên → **My account**
3. Nhìn vào phần bên phải: **API access key**
4. Click **Show** để xem / **Reset** để tạo mới

---

## 🐛 Troubleshooting

**Lỗi `REDMINE_URL and REDMINE_API_KEY must be set`:**
→ Kiểm tra file `.env` hoặc biến `env` trong Cursor MCP config.

**Lỗi `Not a git repository`:**
→ Đặt `GIT_REPO_PATH` đúng đường dẫn đến thư mục chứa `.git`.

**Lỗi 401 Unauthorized từ Redmine:**
→ API Key không đúng hoặc tài khoản không có quyền REST API. Vào Redmine Admin → Settings → Authentication → bật "Enable REST web service".

**Cursor không thấy MCP tools:**
→ Đảm bảo đường dẫn trong `args` là **absolute path** và file `dist/index.js` đã được build.
