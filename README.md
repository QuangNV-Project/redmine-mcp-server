# Redmine MCP Server

MCP (Model Context Protocol) server cho phep Cursor / Claude doc tickets tu Redmine, quan ly nhieu du an (multi-repo), va tu dong tao git branch tuong ung. Ho tro xac thuc bang username/password, bao mat API bang Bearer token, va tich hop MongoDB de quan ly cau hinh nhieu du an.

---

## Tinh nang

### Redmine Tools

| Tool | Mo ta |
|------|-------|
| `get_issue` | Doc chi tiet 1 ticket (mo ta, status, assignee, comment history, sub-tasks) |
| `list_issues` | Liet ke tickets voi filter (project, status, assigned_to, sort, limit) |
| `list_projects` | Liet ke tat ca Redmine projects |
| `update_issue_status` | Cap nhat trang thai ticket (kem comment tuy chon) |
| `add_comment` | Them comment vao ticket |
| `get_issue_statuses` | Xem danh sach cac status co san trong Redmine |

### Git Tools

| Tool | Mo ta |
|------|-------|
| `create_branch_for_issue` | Doc ticket -> tu dong tao & checkout git branch. Tu dong tra cuu repo tu MongoDB neu du an da duoc dang ky |
| `git_current_branch` | Xem branch hien tai cua repository |
| `git_list_branches` | Liet ke tat ca local branches |

### Project Management Tools (yeu cau MongoDB)

| Tool | Mo ta |
|------|-------|
| `register_project` | Dang ky du an voi duong dan FE/BE repo vao MongoDB |
| `list_registered_projects` | Liet ke tat ca du an da dang ky |
| `get_project_config` | Xem chi tiet cau hinh cua 1 du an |
| `update_project` | Cap nhat cau hinh du an (repo paths, tech stack, base branches) |
| `delete_project` | Xoa du an khoi MongoDB |
| `get_project_context` | Doc cau truc thu muc va cac file cau hinh (README, package.json, pom.xml, tsconfig.json...) cua repo de hieu tech stack |

---

## Kien truc

```
mcp-server/
├── index.ts              # MCP server chinh, dinh nghia tools va handlers
├── redmine-client.ts     # Redmine REST API client (Basic Auth)
├── git-helper.ts         # Cac ham thao tac git (tao branch, list, slugify)
├── mongo-client.ts       # MongoDB connection va CRUD cho projects collection
├── middleware.ts          # Express middlewares: auth, rate limit, CORS, helmet
├── types.ts              # TypeScript interfaces va validation functions
├── eslint.config.js      # ESLint v9 flat config + typescript-eslint + prettier
├── nodemon.json          # Nodemon config (auto-reload khi dev)
├── Dockerfile            # Multi-stage Docker build (node:22-alpine)
├── Jenkinsfile           # CI/CD pipeline: lint, build, push Docker Hub, deploy SSH
├── .env.example          # Mau bien moi truong
├── .prettierrc           # Prettier formatting rules
├── .lintstagedrc.json    # lint-staged: eslint + prettier khi git commit
├── cursor-mcp-config.json # Config mau cho Cursor (stdio va SSE)
├── tsconfig.json
├── .gitignore
└── .dockerignore
```

---

## Transport

Server ho tro 2 che do transport:

| Mode | Muc dich | Cau hinh |
|------|----------|----------|
| **stdio** (mac dinh) | Cursor chay truc tiep tren local | `TRANSPORT=stdio` |
| **SSE** | HTTP server cho remote / Docker deployment | `TRANSPORT=sse` |

Khi chay o che do SSE, server expose:
- `GET /sse` — SSE endpoint de Cursor ket noi
- `POST /messages?sessionId=xxx` — nhan messages tu client
- `GET /health` — health check (khong yeu cau auth)

---

## Bao mat (che do SSE)

| Lop bao mat | Chi tiet |
|-------------|---------|
| **Bearer Token Auth** | Moi request (tru `/health`) phai co header `Authorization: Bearer <token>`. Cau hinh qua `MCP_AUTH_TOKEN` |
| **Rate Limiting** | 100 requests / 15 phut moi IP |
| **CORS** | Chi cho phep origins duoc khai bao trong `ALLOWED_ORIGINS` |
| **Helmet** | HTTP security headers (X-Content-Type-Options, X-Frame-Options...) |
| **Input Validation** | Kiem tra issue_id (positive integer), path traversal, limit range (1-100) cho moi tool |

---

## Multi-repo voi MongoDB

Khi co nhieu du an, moi du an co FE va BE repo rieng biet, ban co the dung MongoDB de quan ly:

### MongoDB Schema (`projects` collection)

```json
{
  "_id": "fin-track",
  "name": "Fin Track",
  "redmine_project_id": "fin-track",
  "repos": {
    "fe": {
      "path": "D:/projects/fin-track-fe",
      "tech": "react",
      "base_branch": "dev"
    },
    "be": {
      "path": "D:/projects/fin-track-be",
      "tech": "nestjs",
      "base_branch": "main"
    }
  },
  "created_at": "2026-03-19T...",
  "updated_at": "2026-03-19T..."
}
```

### Workflow

1. Dang ky du an qua tool `register_project` (hoac Cursor Agent se goi giup ban)
2. Khi goi `create_branch_for_issue`, server tu dong tra cuu Redmine project ID -> tim du an trong MongoDB -> chon dung repo (FE/BE) dua tren tham so `target`
3. Neu khong tim thay trong MongoDB, fallback ve `GIT_REPO_PATH` hoac thu muc hien tai

---

## Cai dat

### 1. Clone va cai dependencies

```bash
git clone <repo> mcp-server
cd mcp-server
npm install
```

### 2. Cau hinh bien moi truong

```bash
cp .env.example .env
```

Chinh sua `.env`:

```env
# Redmine (bat buoc)
REDMINE_URL=https://redmine.yourcompany.com
REDMINE_USERNAME=your_username
REDMINE_PASSWORD=your_password

# Transport: "stdio" (mac dinh) hoac "sse"
TRANSPORT=stdio

# Port cho SSE mode (chi dung khi TRANSPORT=sse)
PORT=3000

# Bao mat (chi dung cho SSE mode)
MCP_AUTH_TOKEN=your-secret-token-here
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# MongoDB (tuy chon - bat tinh nang multi-repo)
MONGODB_URI=mongodb://user:password@localhost:27017/mcp-server?authSource=admin

# Git (fallback khi khong co MongoDB)
GIT_REPO_PATH=/path/to/your/local/repo

# Dinh dang ten branch: ticket-id | ticket-id-title
BRANCH_FORMAT=ticket-id-title
```

### 3. Build va chay

```bash
# Build TypeScript
npm run build

# Chay production
npm start

# Hoac chay dev (auto-reload voi nodemon + tsx)
npm run dev
```

---

## Tich hop voi Cursor

### Cach 1: Stdio (local, khuyen dung)

Mo Cursor Settings (`Ctrl+Shift+P` -> "Open MCP Settings"), them vao `mcp.json`:

```json
{
  "mcpServers": {
    "redmine-stdio": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-server/dist/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.yourcompany.com",
        "REDMINE_USERNAME": "your_username",
        "REDMINE_PASSWORD": "your_password",
        "MONGODB_URI": "mongodb://localhost:27017/mcp-server",
        "BRANCH_FORMAT": "ticket-id-title"
      }
    }
  }
}
```

### Cach 2: SSE (remote server / Docker)

Chay server voi `TRANSPORT=sse`, sau do cau hinh Cursor:

```json
{
  "mcpServers": {
    "redmine-sse": {
      "url": "http://your-server:3000/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token-here"
      }
    }
  }
}
```

Sau khi luu config, restart Cursor de MCP server duoc load.

---

## Cach dung trong Cursor

Mo **Cursor Chat** (Agent mode) va go tu nhien:

```
Doc ticket #1234 cho toi
```

```
Tao branch cho ticket #1234, repo BE
```

```
Liet ke tat ca issues dang open cua project my-project
```

```
Cap nhat ticket #1234 sang status "In Progress"
```

```
Them comment vao ticket #1234: "Da fix xong, cho review"
```

```
Dang ky du an fin-track voi FE o D:/projects/fin-track-fe (react) va BE o D:/projects/fin-track-be (nestjs)
```

```
Doc cau truc repo BE cua du an fin-track
```

---

## Quy tac dat ten branch

Voi `BRANCH_FORMAT=ticket-id-title` (mac dinh):

| Ticket | Subject | Branch |
|--------|---------|--------|
| #1234 | Fix login bug on mobile | `feature/1234-fix-login-bug-on-mobile` |
| #567 | Them tinh nang export PDF | `feature/567-them-tinh-nang-export-pdf` |

Voi `BRANCH_FORMAT=ticket-id`:

| Ticket | Branch |
|--------|--------|
| #1234 | `feature/1234` |

Prefix tuy chinh: `fix/`, `hotfix/`, `chore/`... (chi dinh qua tham so `prefix` khi goi tool).

---

## Docker

### Build va chay

```bash
docker build -t mcp-server .
docker run -d \
  --name mcp-server \
  -p 3000:3000 \
  --env-file .env \
  mcp-server
```

Dockerfile su dung multi-stage build voi `node:22-alpine`. Mac dinh khi chay trong Docker, `TRANSPORT=sse` va `PORT=3000`.

### Health check

```bash
curl http://localhost:3000/health
# {"status":"ok","transport":"sse","version":"2.0.0","mongo":true}
```

---

## CI/CD (Jenkins)

Project co san `Jenkinsfile` voi pipeline:

| Stage | Mo ta | Dieu kien |
|-------|-------|-----------|
| Lint & Type Check | `tsc --noEmit` + `eslint .` | Chi cac branch khong phai `main` |
| Build Docker Image | Build voi Docker cache | Chi branch `main` |
| Push Docker Image | Push len Docker Hub | Chi branch `main` |
| Cleanup Local Images | Don dep images cu | Chi branch `main` |
| Deploy to Server | SSH pull image + restart container | Chi branch `main` |

Thong bao ket qua build qua **Telegram** (success/failure).

---

## Development

### Scripts

| Script | Mo ta |
|--------|-------|
| `npm run dev` | Chay dev server voi nodemon (auto-reload khi thay doi `.ts`) |
| `npm run build` | Compile TypeScript sang JavaScript |
| `npm start` | Chay production (`node dist/index.js`) |
| `npm run lint` | Kiem tra loi voi ESLint |
| `npm run lint:fix` | Tu dong fix loi ESLint |
| `npm run format` | Format code voi Prettier |
| `npm run format:check` | Kiem tra format code |

### Code Quality

- **ESLint v9** (flat config) + `typescript-eslint` + `eslint-config-prettier`
- **Prettier** — double quotes, semicolons, trailing comma es5, printWidth 100
- **Husky** + **lint-staged** — tu dong chay `eslint --fix` va `prettier --write` tren cac file `.ts` truoc moi git commit
- **TypeScript strict mode** — bat tat ca strict checks

---

## Troubleshooting

**`REDMINE_URL, REDMINE_USERNAME and REDMINE_PASSWORD must be set`**
Kiem tra file `.env` hoac bien `env` trong Cursor MCP config.

**`Not a git repository`**
Dat `GIT_REPO_PATH` dung duong dan den thu muc chua `.git`, hoac dang ky du an trong MongoDB voi duong dan repo chinh xac.

**`401 Unauthorized` tu Redmine**
Username/password khong dung hoac tai khoan khong co quyen REST API. Vao Redmine Admin -> Settings -> Authentication -> bat "Enable REST web service".

**MongoDB `Authentication failed`**
Thu them `?authSource=admin` vao cuoi `MONGODB_URI`. Neu user duoc tao trong database khac, thay `admin` bang ten database tuong ung.

**`WARNING: MongoDB connection failed. Multi-repo features disabled.`**
Server van chay binh thuong nhung cac tinh nang multi-repo (register/list/get project) se khong kha dung. Kiem tra lai `MONGODB_URI` va dam bao MongoDB dang chay.

**Cursor khong thay MCP tools**
Dam bao duong dan trong `args` la **absolute path** va file `dist/index.js` da duoc build. Restart Cursor sau khi luu config.
