import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

export function createAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      res.status(401).json({ error: "Unauthorized: invalid or missing Bearer token" });
      return;
    }
    next();
  };
}

export function createRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    skip: (req) => req.path === "/sse" || req.path === "/health",
  });
}

export function createCorsMiddleware(allowedOrigins: string) {
  const origins = allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return cors({
    origin: origins.length > 0 ? origins : "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
}

export function createHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
  });
}
