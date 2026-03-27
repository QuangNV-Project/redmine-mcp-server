import * as fs from "fs";
import * as path from "path";
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
import { connectMongo, disconnectMongo } from "./mongo-client.js";
import * as mongo from "./mongo-client.js";
import {
  createAuthMiddleware,
  createCorsMiddleware,
  createHelmetMiddleware,
  createRateLimiter,
} from "./middleware.js";
import { validateLimit, validateNoPathTraversal, validatePositiveInt } from "./types.js";
import type { RepoTarget } from "./types.js";

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const TRANSPORT = (process.env.TRANSPORT || "stdio") as "stdio" | "sse";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MONGODB_URI = process.env.MONGODB_URI || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "";

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
  { name: "redmine-mcp", version: "2.0.0" },
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
          issue_id: { type: "number", description: "The Redmine issue ID (e.g. 1234)" },
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
          project_id: { type: "string", description: "Project identifier or ID to filter by" },
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
      inputSchema: { type: "object", properties: {}, required: [] },
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
          notes: { type: "string", description: "Optional comment to add when changing status" },
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
      inputSchema: { type: "object", properties: {}, required: [] },
    },

    // ── Git tools ──
    {
      name: "create_branch_for_issue",
      description:
        'Create and checkout a git branch for a Redmine issue. Auto-detects the correct repo from MongoDB if a project is registered. Use "target" to pick fe or be repo.',
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "number", description: "The Redmine issue ID to create a branch for" },
          target: {
            type: "string",
            enum: ["fe", "be"],
            description: 'Which repo to create the branch in: "fe" or "be"',
          },
          repo_path: {
            type: "string",
            description:
              "Explicit path to git repo (overrides MongoDB lookup). Falls back to GIT_REPO_PATH env.",
          },
          base_branch: {
            type: "string",
            description:
              "Base branch to create from (auto-detected from project config if omitted)",
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
          repo_path: { type: "string", description: "Path to local git repository" },
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
          repo_path: { type: "string", description: "Path to local git repository" },
        },
        required: [],
      },
    },

    // ── Project management tools ──
    {
      name: "register_project",
      description:
        "Register a project with its FE/BE repo paths in MongoDB. This maps a Redmine project to local repos so branches can be auto-created.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: 'Unique slug for the project (e.g. "fin-track")',
          },
          name: { type: "string", description: 'Display name (e.g. "Fin Track")' },
          redmine_project_id: { type: "string", description: "Redmine project identifier" },
          fe_path: { type: "string", description: "Local path to FE repo" },
          fe_tech: {
            type: "string",
            description: 'FE tech stack (e.g. "react", "vue", "angular")',
          },
          fe_base_branch: {
            type: "string",
            description: 'FE base branch (default: "dev")',
          },
          be_path: { type: "string", description: "Local path to BE repo" },
          be_tech: {
            type: "string",
            description: 'BE tech stack (e.g. "spring-boot", "nestjs", "express")',
          },
          be_base_branch: {
            type: "string",
            description: 'BE base branch (default: "main")',
          },
        },
        required: ["project_id", "name", "redmine_project_id"],
      },
    },
    {
      name: "list_registered_projects",
      description: "List all projects registered in MongoDB with their repo paths.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_project_config",
      description: "Get detailed config of a registered project by its slug ID.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The project slug ID" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "update_project",
      description: "Update an existing project's config (repo paths, tech, base branches).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The project slug ID to update" },
          name: { type: "string", description: "New display name" },
          redmine_project_id: { type: "string", description: "New Redmine project identifier" },
          fe_path: { type: "string", description: "New FE repo path" },
          fe_tech: { type: "string", description: "New FE tech stack" },
          fe_base_branch: { type: "string", description: "New FE base branch" },
          be_path: { type: "string", description: "New BE repo path" },
          be_tech: { type: "string", description: "New BE tech stack" },
          be_base_branch: { type: "string", description: "New BE base branch" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "delete_project",
      description: "Delete a registered project from MongoDB.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The project slug ID to delete" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "get_project_context",
      description:
        "Read the structure and key config files (README, package.json, pom.xml) of a registered project's repo to understand its tech stack and conventions.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The project slug ID" },
          target: {
            type: "string",
            enum: ["fe", "be"],
            description: 'Which repo to read: "fe" or "be"',
          },
        },
        required: ["project_id", "target"],
      },
    },
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── get_issue ──
      case "get_issue": {
        const issueId = args?.issue_id as number;
        const err = validatePositiveInt(issueId, "issue_id");
        if (err)
          return {
            content: [{ type: "text", text: `Validation error: ${err.message}` }],
            isError: true,
          };

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

**Project:** ${issue.project.name} (${issue.project.id})
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

      // ── list_issues ──
      case "list_issues": {
        const limitErr = validateLimit(args?.limit);
        if (limitErr)
          return {
            content: [{ type: "text", text: `Validation error: ${limitErr.message}` }],
            isError: true,
          };

        const { issues, total_count } = await redmine.listIssues({
          project_id: args?.project_id as string,
          status_id: (args?.status_id as string) || "open",
          assigned_to_id: args?.assigned_to_id as string,
          limit: (args?.limit as number) || 25,
          sort: (args?.sort as string) || "updated_on:desc",
        });

        if (issues.length === 0) {
          return { content: [{ type: "text", text: "No issues found matching the criteria." }] };
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

      // ── list_projects ──
      case "list_projects": {
        const projects = await redmine.listProjects();
        const lines = projects.map(
          (p) => `- **${p.name}** (identifier: \`${p.identifier}\`, ID: ${p.id})`
        );
        return {
          content: [
            { type: "text", text: `**${projects.length} Projects:**\n\n${lines.join("\n")}` },
          ],
        };
      }

      // ── update_issue_status ──
      case "update_issue_status": {
        const issueId = args?.issue_id as number;
        const statusId = args?.status_id as number;
        const e1 = validatePositiveInt(issueId, "issue_id");
        const e2 = validatePositiveInt(statusId, "status_id");
        if (e1 || e2) {
          const msg = [e1, e2]
            .filter(Boolean)
            .map((e) => e!.message)
            .join("; ");
          return { content: [{ type: "text", text: `Validation error: ${msg}` }], isError: true };
        }

        const notes = args?.notes as string | undefined;
        await redmine.updateIssueStatus(issueId, statusId, notes);
        return {
          content: [
            {
              type: "text",
              text: `Issue #${issueId} status updated to ID ${statusId}.${notes ? " Comment added." : ""}`,
            },
          ],
        };
      }

      // ── add_comment ──
      case "add_comment": {
        const issueId = args?.issue_id as number;
        const err = validatePositiveInt(issueId, "issue_id");
        if (err)
          return {
            content: [{ type: "text", text: `Validation error: ${err.message}` }],
            isError: true,
          };

        const notes = args?.notes as string;
        if (!notes || notes.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Validation error: notes cannot be empty" }],
            isError: true,
          };
        }
        await redmine.addComment(issueId, notes);
        return { content: [{ type: "text", text: `Comment added to issue #${issueId}.` }] };
      }

      // ── get_issue_statuses ──
      case "get_issue_statuses": {
        const statuses = await redmine.getIssueStatuses();
        const lines = statuses.map(
          (s) => `- ID **${s.id}**: ${s.name}${s.is_closed ? " _(closed)_" : ""}`
        );
        return {
          content: [{ type: "text", text: `**Available Statuses:**\n\n${lines.join("\n")}` }],
        };
      }

      // ── create_branch_for_issue ──
      case "create_branch_for_issue": {
        const issueId = args?.issue_id as number;
        const err = validatePositiveInt(issueId, "issue_id");
        if (err)
          return {
            content: [{ type: "text", text: `Validation error: ${err.message}` }],
            isError: true,
          };

        const target = args?.target as RepoTarget | undefined;
        const prefix = (args?.prefix as string) || "feature";
        const issue = await redmine.getIssue(issueId, false);

        let repoPath: string;
        let baseBranch: string;

        const explicitPath = args?.repo_path as string | undefined;
        const pathErr = validateNoPathTraversal(explicitPath, "repo_path");
        if (pathErr)
          return {
            content: [{ type: "text", text: `Validation error: ${pathErr.message}` }],
            isError: true,
          };

        if (explicitPath) {
          repoPath = explicitPath;
          baseBranch = (args?.base_branch as string) || "main";
        } else if (MONGODB_URI) {
          let projectConfig = await mongo.findProjectByRedmine(
            issue.project.name,
            issue.project.id
          );

          if (!projectConfig) {
            try {
              const redmineProject = await redmine.getProject(String(issue.project.id));
              projectConfig = await mongo.getProjectByRedmineId(redmineProject.identifier);
            } catch {
              /* Redmine project lookup failed, continue to fallback */
            }
          }

          if (projectConfig && target) {
            const repoConfig = projectConfig.repos[target];
            if (!repoConfig) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No ${target} repo configured for project "${projectConfig.name}". Use register_project to add it.`,
                  },
                ],
                isError: true,
              };
            }
            repoPath = repoConfig.path;
            baseBranch = (args?.base_branch as string) || repoConfig.base_branch;
          } else if (projectConfig && !target) {
            const available = Object.keys(projectConfig.repos).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Project "${projectConfig.name}" has repos: ${available}. Please specify target ("fe" or "be").`,
                },
              ],
              isError: true,
            };
          } else {
            repoPath = process.env.GIT_REPO_PATH || process.cwd();
            baseBranch = (args?.base_branch as string) || "main";
          }
        } else {
          repoPath = process.env.GIT_REPO_PATH || process.cwd();
          baseBranch = (args?.base_branch as string) || "main";
        }

        if (!isGitRepo(repoPath)) {
          return {
            content: [{ type: "text", text: `Not a git repository: \`${repoPath}\`` }],
            isError: true,
          };
        }

        const branchName = buildBranchName(issueId, issue.subject, BRANCH_FORMAT, prefix);
        const result = createBranch(branchName, repoPath, baseBranch);

        const text = `${result.success ? "**Branch created successfully**" : "**Failed to create branch**"}

**Issue:** #${issue.id} — ${issue.subject}
**Status:** ${issue.status.name} | **Priority:** ${issue.priority.name}
**Assigned to:** ${issue.assigned_to?.name || "Unassigned"}
**Branch:** \`${branchName}\`
**Repo:** \`${repoPath}\`
**Base:** \`${baseBranch}\`
${result.alreadyExists ? "_(Branch already existed, switched to it)_" : ""}

---
${issue.description ? issue.description.slice(0, 500) + (issue.description.length > 500 ? "..." : "") : "_No description._"}`;

        return { content: [{ type: "text", text }], isError: !result.success };
      }

      // ── git_current_branch ──
      case "git_current_branch": {
        const rp = args?.repo_path as string | undefined;
        const pathErr = validateNoPathTraversal(rp, "repo_path");
        if (pathErr)
          return {
            content: [{ type: "text", text: `Validation error: ${pathErr.message}` }],
            isError: true,
          };

        const repoPath = resolveRepoPath(rp);
        if (!isGitRepo(repoPath)) {
          return {
            content: [{ type: "text", text: `Not a git repository: \`${repoPath}\`` }],
            isError: true,
          };
        }
        const branch = getCurrentBranch(repoPath);
        return {
          content: [{ type: "text", text: `Current branch in \`${repoPath}\`: **${branch}**` }],
        };
      }

      // ── git_list_branches ──
      case "git_list_branches": {
        const rp = args?.repo_path as string | undefined;
        const pathErr = validateNoPathTraversal(rp, "repo_path");
        if (pathErr)
          return {
            content: [{ type: "text", text: `Validation error: ${pathErr.message}` }],
            isError: true,
          };

        const repoPath = resolveRepoPath(rp);
        if (!isGitRepo(repoPath)) {
          return {
            content: [{ type: "text", text: `Not a git repository: \`${repoPath}\`` }],
            isError: true,
          };
        }
        const branches = listBranches(repoPath);
        const current = getCurrentBranch(repoPath);
        const lines = branches.map((b) => `${b === current ? "→ " : "  "} \`${b}\``);
        return {
          content: [
            { type: "text", text: `**Local branches in \`${repoPath}\`:**\n\n${lines.join("\n")}` },
          ],
        };
      }

      // ── register_project ──
      case "register_project": {
        if (!MONGODB_URI) {
          return {
            content: [{ type: "text", text: "MongoDB not configured. Set MONGODB_URI in .env" }],
            isError: true,
          };
        }

        const projectId = args?.project_id as string;
        const projectName = args?.name as string;
        const redmineProjectId = args?.redmine_project_id as string;

        const repos: Record<string, { path: string; tech: string; base_branch: string }> = {};
        if (args?.fe_path) {
          repos.fe = {
            path: args.fe_path as string,
            tech: (args.fe_tech as string) || "unknown",
            base_branch: (args.fe_base_branch as string) || "dev",
          };
        }
        if (args?.be_path) {
          repos.be = {
            path: args.be_path as string,
            tech: (args.be_tech as string) || "unknown",
            base_branch: (args.be_base_branch as string) || "main",
          };
        }

        const saved = await mongo.upsertProject({
          _id: projectId,
          name: projectName,
          redmine_project_id: redmineProjectId,
          repos,
        });

        return {
          content: [
            {
              type: "text",
              text: `Project **${saved.name}** registered.\n\nRedmine: \`${saved.redmine_project_id}\`\n${saved.repos.fe ? `FE: \`${saved.repos.fe.path}\` (${saved.repos.fe.tech}, base: ${saved.repos.fe.base_branch})` : "FE: not configured"}\n${saved.repos.be ? `BE: \`${saved.repos.be.path}\` (${saved.repos.be.tech}, base: ${saved.repos.be.base_branch})` : "BE: not configured"}`,
            },
          ],
        };
      }

      // ── list_registered_projects ──
      case "list_registered_projects": {
        if (!MONGODB_URI) {
          return {
            content: [{ type: "text", text: "MongoDB not configured. Set MONGODB_URI in .env" }],
            isError: true,
          };
        }

        const projects = await mongo.listAllProjects();
        if (projects.length === 0) {
          return {
            content: [
              { type: "text", text: "No projects registered. Use `register_project` to add one." },
            ],
          };
        }

        const lines = projects.map((p) => {
          const fe = p.repos.fe ? `FE: ${p.repos.fe.tech}` : "";
          const be = p.repos.be ? `BE: ${p.repos.be.tech}` : "";
          const repos = [fe, be].filter(Boolean).join(" | ");
          return `- **${p.name}** (\`${p._id}\`) — Redmine: \`${p.redmine_project_id}\` [${repos}]`;
        });
        return {
          content: [
            {
              type: "text",
              text: `**${projects.length} Registered Projects:**\n\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // ── get_project_config ──
      case "get_project_config": {
        if (!MONGODB_URI) {
          return {
            content: [{ type: "text", text: "MongoDB not configured. Set MONGODB_URI in .env" }],
            isError: true,
          };
        }

        const project = await mongo.getProject(args?.project_id as string);
        if (!project) {
          return {
            content: [{ type: "text", text: `Project "${args?.project_id}" not found.` }],
            isError: true,
          };
        }

        let text = `# ${project.name} (\`${project._id}\`)\n\n**Redmine project:** \`${project.redmine_project_id}\`\n`;
        if (project.repos.fe) {
          text += `\n**FE Repo:**\n- Path: \`${project.repos.fe.path}\`\n- Tech: ${project.repos.fe.tech}\n- Base branch: \`${project.repos.fe.base_branch}\`\n`;
        }
        if (project.repos.be) {
          text += `\n**BE Repo:**\n- Path: \`${project.repos.be.path}\`\n- Tech: ${project.repos.be.tech}\n- Base branch: \`${project.repos.be.base_branch}\`\n`;
        }
        text += `\nCreated: ${project.created_at?.toISOString() || "N/A"}\nUpdated: ${project.updated_at?.toISOString() || "N/A"}`;

        return { content: [{ type: "text", text }] };
      }

      // ── update_project ──
      case "update_project": {
        if (!MONGODB_URI) {
          return {
            content: [{ type: "text", text: "MongoDB not configured. Set MONGODB_URI in .env" }],
            isError: true,
          };
        }

        const existing = await mongo.getProject(args?.project_id as string);
        if (!existing) {
          return {
            content: [{ type: "text", text: `Project "${args?.project_id}" not found.` }],
            isError: true,
          };
        }

        const updatedRepos = { ...existing.repos };
        if (args?.fe_path || args?.fe_tech || args?.fe_base_branch) {
          updatedRepos.fe = {
            path: (args.fe_path as string) || existing.repos.fe?.path || "",
            tech: (args.fe_tech as string) || existing.repos.fe?.tech || "unknown",
            base_branch: (args.fe_base_branch as string) || existing.repos.fe?.base_branch || "dev",
          };
        }
        if (args?.be_path || args?.be_tech || args?.be_base_branch) {
          updatedRepos.be = {
            path: (args.be_path as string) || existing.repos.be?.path || "",
            tech: (args.be_tech as string) || existing.repos.be?.tech || "unknown",
            base_branch:
              (args.be_base_branch as string) || existing.repos.be?.base_branch || "main",
          };
        }

        const saved = await mongo.upsertProject({
          _id: existing._id,
          name: (args?.name as string) || existing.name,
          redmine_project_id: (args?.redmine_project_id as string) || existing.redmine_project_id,
          repos: updatedRepos,
        });

        return { content: [{ type: "text", text: `Project **${saved.name}** updated.` }] };
      }

      // ── delete_project ──
      case "delete_project": {
        if (!MONGODB_URI) {
          return {
            content: [{ type: "text", text: "MongoDB not configured. Set MONGODB_URI in .env" }],
            isError: true,
          };
        }

        const deleted = await mongo.deleteProject(args?.project_id as string);
        if (!deleted) {
          return {
            content: [{ type: "text", text: `Project "${args?.project_id}" not found.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Project "${args?.project_id}" deleted.` }] };
      }

      // ── get_project_context ──
      case "get_project_context": {
        if (!MONGODB_URI) {
          return {
            content: [{ type: "text", text: "MongoDB not configured. Set MONGODB_URI in .env" }],
            isError: true,
          };
        }

        const project = await mongo.getProject(args?.project_id as string);
        if (!project) {
          return {
            content: [{ type: "text", text: `Project "${args?.project_id}" not found.` }],
            isError: true,
          };
        }

        const target = args?.target as RepoTarget;
        const repoConfig = project.repos[target];
        if (!repoConfig) {
          return {
            content: [
              { type: "text", text: `No ${target} repo configured for project "${project.name}".` },
            ],
            isError: true,
          };
        }

        const repoPath = repoConfig.path;
        if (!fs.existsSync(repoPath)) {
          return {
            content: [{ type: "text", text: `Repo path does not exist: \`${repoPath}\`` }],
            isError: true,
          };
        }

        let context = `# ${project.name} — ${target.toUpperCase()} Repo\n\n`;
        context += `**Path:** \`${repoPath}\`\n**Tech:** ${repoConfig.tech}\n**Base branch:** \`${repoConfig.base_branch}\`\n\n`;

        // Directory listing (depth 2)
        context += "## Directory Structure\n```\n";
        try {
          const entries = fs.readdirSync(repoPath, { withFileTypes: true });
          for (const entry of entries) {
            if (
              entry.name.startsWith(".") ||
              entry.name === "node_modules" ||
              entry.name === "dist" ||
              entry.name === "target" ||
              entry.name === "build"
            )
              continue;
            context += entry.isDirectory() ? `${entry.name}/\n` : `${entry.name}\n`;
            if (entry.isDirectory()) {
              try {
                const sub = fs.readdirSync(path.join(repoPath, entry.name), {
                  withFileTypes: true,
                });
                for (const s of sub.slice(0, 20)) {
                  context += `  ${s.isDirectory() ? s.name + "/" : s.name}\n`;
                }
                if (sub.length > 20) context += `  ... (${sub.length - 20} more)\n`;
              } catch {
                /* skip unreadable */
              }
            }
          }
        } catch {
          context += "(unable to read directory)\n";
        }
        context += "```\n\n";

        const configFiles = [
          "README.md",
          "package.json",
          "pom.xml",
          "build.gradle",
          "tsconfig.json",
          "Cargo.toml",
        ];
        for (const file of configFiles) {
          const filePath = path.join(repoPath, file);
          if (fs.existsSync(filePath)) {
            try {
              const content = fs.readFileSync(filePath, "utf-8");
              const truncated =
                content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content;
              context += `## ${file}\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
            } catch {
              /* skip unreadable */
            }
          }
        }

        return { content: [{ type: "text", text: context }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
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

  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware(ALLOWED_ORIGINS));
  app.use(createRateLimiter());

  if (MCP_AUTH_TOKEN) {
    app.use(createAuthMiddleware(MCP_AUTH_TOKEN));
  }

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
    res.json({ status: "ok", transport: "sse", version: "2.0.0", mongo: !!MONGODB_URI });
  });

  app.listen(PORT, () => {
    console.error(`Redmine MCP Server running on http://localhost:${PORT}`);
    console.error(`  SSE endpoint: http://localhost:${PORT}/sse`);
    console.error(`  Health check: http://localhost:${PORT}/health`);
    console.error(`  Auth: ${MCP_AUTH_TOKEN ? "enabled" : "disabled"}`);
    console.error(`  MongoDB: ${MONGODB_URI ? "connected" : "disabled"}`);
  });
}

async function main() {
  if (MONGODB_URI) {
    try {
      await connectMongo(MONGODB_URI);
    } catch (err) {
      console.error(
        "WARNING: MongoDB connection failed. Multi-repo features disabled.",
        err instanceof Error ? err.message : err
      );
    }
  }

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

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await disconnectMongo();
  process.exit(1);
});
