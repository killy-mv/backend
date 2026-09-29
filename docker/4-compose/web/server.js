// A visit counter. The count lives in Redis, not in this process, so it
// survives restarts of the web container and is shared between replicas.
const http = require("node:http");
const os = require("node:os");
const { createClient } = require("redis");

// "redis" is the service name in docker-compose.yml. Compose puts both
// containers on one network where each service name resolves to its container.
const redis = createClient({ url: process.env.REDIS_URL || "redis://redis:6379" });

http
  .createServer(async (req, res) => {
    if (req.url !== "/") return res.writeHead(404).end();
    const visits = await redis.incr("visits");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ visits, servedBy: os.hostname() }, null, 2));
  })
  .listen(3000, async () => {
    await redis.connect();
    console.log("listening on port 3000, connected to redis");
  });
