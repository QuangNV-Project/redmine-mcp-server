import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import express from "express";
import { RedmineClient } from "./redmine-client.js";
import {
  buildBranchName,
  createBranch,
  getCurrentBranch,
  isGitRepo,
  listBranches,
  resolveRepoPath,
} from "./git-helper.js";

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const TRANSPORT = (process.env.TRANSPORT || "stdio") as "stdio" | "sse";
const PORT = parseInt(process.env.PORT || "3000", 10);

const REDMINE_URL = process.env.REDMINE_URL || "";
const REDMINE_USERNAME = process.env.REDMINE_USERNAME || "";
const REDMINE_PASSWORD = process.env.REDMINE_PASSWORD || "";
const BRANCH_FORMAT =
  (process.env.BRANCH_FORMAT as "ticket-id" | "ticket-id-title") || "ticket-id-title";

if (!REDMINE_URL || !REDMINE_USERNAME || !REDMINE_PASSWORD) {
  console.error(
    "ERROR: REDMINE_URL, REDMINE_USERNAME and REDMINE_PASSWORD must be set in environment or .env file"
  );
  process.exit(1);
}

const redmine = new RedmineClient(REDMINE_URL, REDMINE_USERNAME, REDMINE_PASSWORD);

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "redmine-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Redmine tools ──
    {
      name: "get_issue",
      description:
        "Get full details of a Redmine issue/ticket by its ID, including description, status, assignee, and comment history.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: {
            type: "number",
            description: "The Redmine issue ID (e.g. 1234)",
          },
          include_journals: {
            type: "boolean",
            description: "Include comment history (default: true)",
          },
        },
        required: ["issue_id"],
      },
    },
    {
      name: "list_issues",
      description:
        "List Redmine issues with optional filters. Use this to find issues assigned to you or in a project.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Project identifier or ID to filter by",
          },
          status_id: {
            type: "string",
            description: 'Status filter: "open", "closed", "*" (all), or a numeric status ID',
          },
          assigned_to_id: {
            type: "string",
            description: 'Filter by assignee: "me" or a numeric user ID',
          },
          limit: {
            type: "number",
            description: "Number of results to return (default: 25, max: 100)",
          },
          sort: {
            type: "string",
            description: 'Sort field, e.g. "updated_on:desc", "priority:desc"',
          },
        },
        required: [],
      },
    },
    {
      name: "list_projects",
      description: "List all Redmine projects available to your account.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "update_issue_status",
      description: "Update the status of a Redmine issue.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "number", description: "The Redmine issue ID" },
          status_id: {
            type: "number",
            description: "The new status ID (use get_issue_statuses to list options)",
          },
          notes: {
            type: "string",
            description: "Optional comment to add when changing status",
          },
        },
        required: ["issue_id", "status_id"],
      },
    },
    {
      name: "add_comment",
      description: "Add a comment/note to a Redmine issue.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "number", description: "The Redmine issue ID" },
          notes: { type: "string", description: "The comment text to add" },
        },
        required: ["issue_id", "notes"],
      },
    },
    {
      name: "get_issue_statuses",
      description: "List all available issue statuses in Redmine.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },

    // ── Git tools ──
    {
      name: "create_branch_for_issue",
      description:
        "Create and checkout a git branch for a Redmine issue. The branch name is derived from the issue ID and title. This is the main workflow tool: reads the issue then sets up the branch.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: {
            type: "number",
            description: "The Redmine issue ID to create a branch for",
          },
          repo_path: {
            type: "string",
            description:
              "Path to local git repository (defaults to GIT_REPO_PATH env or current directory)",
          },
          base_branch: {
            type: "string",
            description: 'Base branch to create from (default: "main" or "develop")',
          },
          prefix: {
            type: "string",
            description: 'Branch prefix (default: "feature"). Use "fix", "hotfix", "chore" etc.',
          },
        },
        required: ["issue_id"],
      },
    },
    {
      name: "git_current_branch",
      description: "Get the current git branch in the repository.",
      inputSchema: {
        type: "object",
        properties: {
          repo_path: {
            type: "string",
            description: "Path to local git repository",
          },
        },
        required: [],
      },
    },
    {
      name: "git_list_branches",
      description: "List all local git branches in the repository.",
      inputSchema: {
        type: "object",
        properties: {
          repo_path: {
            type: "string",
            description: "Path to local git repository",
          },
        },
        required: [],
      },
    },
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── get_issue ──────────────────────────────────────────────────────────
      case "get_issue": {
        const issueId = args?.issue_id as number;
        const includeJournals = args?.include_journals !== false;
        const issue = await redmine.getIssue(issueId, includeJournals);

        const journalsSection =
          issue.journals && issue.journals.length > 0
            ? "\n\n### Comment History\n" +
              issue.journals
                .filter((j) => j.notes)
                .map(
                  (j) =>
                    `**${j.user.name}** (${new Date(j.created_on).toLocaleDateString("vi-VN")}):\n${j.notes}`
                )
                .join("\n\n---\n\n")
            : "";

        const childrenSection =
          issue.children && issue.children.length > 0
            ? "\n\n### Sub-tasks\n" +
              issue.children.map((c) => `- #${c.id}: ${c.subject}`).join("\n")
            : "";

        const content = `# [#${issue.id}] ${issue.subject}

**Project:** ${issue.project.name}
**Tracker:** ${issue.tracker.name}
**Status:** ${issue.status.name}
**Priority:** ${issue.priority.name}
**Author:** ${issue.author.name}
**Assigned to:** ${issue.assigned_to?.name || "Unassigned"}
**Progress:** ${issue.done_ratio}%
**Created:** ${new Date(issue.created_on).toLocaleDateString("vi-VN")}
**Updated:** ${new Date(issue.updated_on).toLocaleDateString("vi-VN")}
${issue.due_date ? `**Due date:** ${issue.due_date}` : ""}

## Description
${issue.description || "_No description provided._"}
${childrenSection}${journalsSection}`;

        return { content: [{ type: "text", text: content }] };
      }

      // ── list_issues ────────────────────────────────────────────────────────
      case "list_issues": {
        const { issues, total_count } = await redmine.listIssues({
          project_id: args?.project_id as string,
          status_id: (args?.status_id as string) || "open",
          assigned_to_id: args?.assigned_to_id as string,
          limit: (args?.limit as number) || 25,
          sort: (args?.sort as string) || "updated_on:desc",
        });

        if (issues.length === 0) {
          return {
            content: [{ type: "text", text: "No issues found matching the criteria." }],
          };
        }

        const lines = issues.map(
          (i) =>
            `- **#${i.id}** [${i.status.name}] [${i.priority.name}] ${i.subject}` +
            (i.assigned_to ? ` → ${i.assigned_to.name}` : "")
        );

        const text =
          `Found **${total_count}** issues (showing ${issues.length}):\n\n` + lines.join("\n");

        return { content: [{ type: "text", text }] };
      }

      // ── list_projects ──────────────────────────────────────────────────────
      case "list_projects": {
        const projects = await redmine.listProjects();
        const lines = projects.map(
          (p) => `- **${p.name}** (identifier: \`${p.identifier}\`, ID: ${p.id})`
        );
        return {
          content: [
            {
              type: "text",
              text: `**${projects.length} Projects:**\n\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // ── update_issue_status ────────────────────────────────────────────────
      case "update_issue_status": {
        const issueId = args?.issue_id as number;
        const statusId = args?.status_id as number;
        const notes = args?.notes as string | undefined;
        await redmine.updateIssueStatus(issueId, statusId, notes);
        return {
          content: [
            {
              type: "text",
              text: `✅ Issue #${issueId} status updated to ID ${statusId}.${notes ? ` Comment added.` : ""}`,
            },
          ],
        };
      }

      // ── add_comment ────────────────────────────────────────────────────────
      case "add_comment": {
        const issueId = args?.issue_id as number;
        const notes = args?.notes as string;
        await redmine.addComment(issueId, notes);
        return {
          content: [
            {
              type: "text",
              text: `✅ Comment added to issue #${issueId}.`,
            },
          ],
        };
      }

      // ── get_issue_statuses ─────────────────────────────────────────────────
      case "get_issue_statuses": {
        const statuses = await redmine.getIssueStatuses();
        const lines = statuses.map(
          (s) => `- ID **${s.id}**: ${s.name}${s.is_closed ? " _(closed)_" : ""}`
        );
        return {
          content: [
            {
              type: "text",
              text: `**Available Statuses:**\n\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // ── create_branch_for_issue ────────────────────────────────────────────
      case "create_branch_for_issue": {
        const issueId = args?.issue_id as number;
        const repoPath = resolveRepoPath(args?.repo_path as string);
        const baseBranch = (args?.base_branch as string) || "main";
        const prefix = (args?.prefix as string) || "feature";

        // Validate git repo
        if (!isGitRepo(repoPath)) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Not a git repository: \`${repoPath}\`\nPlease set GIT_REPO_PATH in .env or pass repo_path explicitly.`,
              },
            ],
          };
        }

        // Fetch issue details
        const issue = await redmine.getIssue(issueId, false);
        const branchName = buildBranchName(issueId, issue.subject, BRANCH_FORMAT, prefix);

        // Create branch
        const result = createBranch(branchName, repoPath, baseBranch);

        const statusIcon = result.success ? "✅" : "❌";
        const text = `${statusIcon} **${result.message}**

**Issue:** #${issue.id} — ${issue.subject}
**Status:** ${issue.status.name}
**Priority:** ${issue.priority.name}
**Assigned to:** ${issue.assigned_to?.name || "Unassigned"}

**Branch:** \`${branchName}\`
**Repo:** \`${repoPath}\`

${result.success ? "You can now start coding! 🚀" : ""}

---
**Issue description preview:**
${issue.description ? issue.description.slice(0, 500) + (issue.description.length > 500 ? "…" : "") : "_No description._"}`;

        return { content: [{ type: "text", text }] };
      }

      // ── git_current_branch ─────────────────────────────────────────────────
      case "git_current_branch": {
        const repoPath = resolveRepoPath(args?.repo_path as string);
        if (!isGitRepo(repoPath)) {
          return {
            content: [{ type: "text", text: `❌ Not a git repository: \`${repoPath}\`` }],
          };
        }
        const branch = getCurrentBranch(repoPath);
        return {
          content: [
            {
              type: "text",
              text: `Current branch in \`${repoPath}\`: **${branch}**`,
            },
          ],
        };
      }

      // ── git_list_branches ──────────────────────────────────────────────────
      case "git_list_branches": {
        const repoPath = resolveRepoPath(args?.repo_path as string);
        if (!isGitRepo(repoPath)) {
          return {
            content: [{ type: "text", text: `❌ Not a git repository: \`${repoPath}\`` }],
          };
        }
        const branches = listBranches(repoPath);
        const current = getCurrentBranch(repoPath);
        const lines = branches.map((b) => `${b === current ? "→ " : "  "} \`${b}\``);
        return {
          content: [
            {
              type: "text",
              text: `**Local branches in \`${repoPath}\`:**\n\n${lines.join("\n")}`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Redmine MCP Server running on stdio");
}

async function startSSE() {
  const app = express();
  const sessions = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    res.on("close", () => sessions.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Invalid or expired session" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "sse", version: "1.0.0" });
  });

  app.listen(PORT, () => {
    console.error(`Redmine MCP Server running on http://localhost:${PORT}`);
    console.error(`  SSE endpoint: http://localhost:${PORT}/sse`);
    console.error(`  Health check: http://localhost:${PORT}/health`);
  });
}

async function main() {
  switch (TRANSPORT) {
    case "sse":
      await startSSE();
      break;
    case "stdio":
      await startStdio();
      break;
    default: {
      const _exhaustive: never = TRANSPORT;
      console.error(`Unknown transport: ${_exhaustive}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
