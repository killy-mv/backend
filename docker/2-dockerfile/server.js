// A tiny web server with zero dependencies, so the Dockerfile stays simple.
// It reports the hostname, which inside a container is the container's ID.
const http = require("node:http");
const os = require("node:os");

const PORT = process.env.PORT || 3000;
const GREETING = process.env.GREETING || "hello from a container";

http
  .createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        {
          greeting: GREETING,
          hostname: os.hostname(),
          node: process.version,
          platform: `${os.type()} ${os.release()}`,
        },
        null,
        2,
      ),
    );
  })
  .listen(PORT, () => console.log(`listening on port ${PORT}`));
