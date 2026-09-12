import type { Request, RequestHandler } from "express";

type UserResolver = (req: Request) => Promise<{ active: boolean } | null | undefined>;

/** All business endpoints require an active account, including read-only routes. */
export function requireActiveUser(resolveUser: UserResolver): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }
      if (!user.active) {
        res.status(403).json({ error: "This account is inactive. Contact your administrator." });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
