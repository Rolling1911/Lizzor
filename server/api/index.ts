import { Router } from "express";
import { healthRouter } from "./health.js";
import { authRouter } from "./auth.js";
import { adminRouter } from "./admin.js";
import { catalogRouter } from "./catalog.js";
import { inventoryRouter } from "./inventory.js";
import { pricingRouter } from "./pricing.js";
import { commerceRouter } from "./commerce.js";
import { paymentsRouter } from "./payments.js";
import { fulfillmentRouter } from "./fulfillment.js";
import { wishlistRouter } from "./wishlist.js";
import { promotionsRouter } from "./promotions.js";
import { analyticsRouter } from "./analytics.js";
import { accountsRouter } from "./accounts.js";
import { notificationsRouter } from "./notifications.js";
import { operationsRouter } from "./operations.js";
import { seoRouter } from "./seo.js";
import { storefrontRouter } from "./storefront.js";
import { auditRouter } from "./audit.js";
import { rbacRouter } from "./rbac.js";
import { customerCareRouter } from "./customer-care.js";
import { contentControlRouter } from "./content-control.js";
import { resendWebhooksRouter } from "./resend-webhooks.js";
import { legalRouter } from "./legal.js";
import { tooniesRouter } from "./toonies.js";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(resendWebhooksRouter);
apiRouter.use(authRouter);
apiRouter.use(accountsRouter);
apiRouter.use(notificationsRouter);
apiRouter.use(operationsRouter);
apiRouter.use(adminRouter);
apiRouter.use(catalogRouter);
apiRouter.use(inventoryRouter);
apiRouter.use(pricingRouter);
apiRouter.use(commerceRouter);
apiRouter.use(paymentsRouter);
apiRouter.use(fulfillmentRouter);
apiRouter.use(wishlistRouter);
apiRouter.use(promotionsRouter);
apiRouter.use(analyticsRouter);
apiRouter.use(seoRouter);
apiRouter.use(storefrontRouter);
apiRouter.use(auditRouter);
apiRouter.use(rbacRouter);
apiRouter.use(customerCareRouter);
apiRouter.use(contentControlRouter);
apiRouter.use(legalRouter);
apiRouter.use(tooniesRouter);
apiRouter.get("/meta", (_req, res) => {
  res.json({
    data: {
      name: "Lizzor API",
      version: "v1",
      status: "foundation",
      message: "Business resources will be introduced in future phases.",
    },
  });
});