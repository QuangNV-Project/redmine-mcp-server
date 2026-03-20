export interface RepoConfig {
  path: string;
  tech: string;
  base_branch: string;
}

export interface ProjectConfig {
  _id: string;
  name: string;
  redmine_project_id: string;
  repos: {
    fe?: RepoConfig;
    be?: RepoConfig;
  };
  created_at: Date;
  updated_at: Date;
}

export type RepoTarget = "fe" | "be";

export interface ValidationError {
  field: string;
  message: string;
}

export function validatePositiveInt(value: unknown, field: string): ValidationError | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { field, message: `${field} must be a positive integer` };
  }
  return null;
}

export function validateNoPathTraversal(value: unknown, field: string): ValidationError | null {
  if (typeof value !== "string") return null;
  if (value.includes("..") || value.includes("\0")) {
    return { field, message: `${field} contains invalid path characters` };
  }
  return null;
}

export function validateLimit(value: unknown): ValidationError | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || value < 1 || value > 100) {
    return { field: "limit", message: "limit must be between 1 and 100" };
  }
  return null;
}
