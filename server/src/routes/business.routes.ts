
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

// GET /api/business
router.get("/", requireAuth, (req, res) => {
    res.json({
        success: true,
        message: "Authenticated business API is working.",
        userId: req.session.userId
    });
});

export default router;
