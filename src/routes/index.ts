import { Router } from "@/lib/http";
import { registerAuthRoutes } from "./auth.routes";
import { registerPlatformRoutes } from "./platform.routes";
import { registerOrgRoutes } from "./org.routes";
import { registerFinanceRoutes } from "./finance.routes";
import { registerSavingsRoutes } from "./savings.routes";
import { registerPersonalRoutes } from "./personal.routes";

export function buildRouter(): Router {
  const r = new Router();
  registerAuthRoutes(r);
  registerPlatformRoutes(r);
  registerOrgRoutes(r);
  registerFinanceRoutes(r);
  registerSavingsRoutes(r);
  registerPersonalRoutes(r);
  return r;
}
