const express = require("express");
const router = express.Router();

router.use(require("./authRoutes"));
router.use(require("./roomRoutes"));

module.exports = router;
