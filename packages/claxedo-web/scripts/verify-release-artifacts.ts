import { downloads } from "../src/config"

const results = await Promise.all(
  downloads.map(async (download) => ({
    download,
    response: await fetch(download.href, { method: "HEAD", redirect: "follow" }),
  })),
)

results.forEach(({ download, response }) => {
  console.log(`${response.status} ${download.platform} ${response.url}`)
})

if (results.some(({ response }) => !response.ok)) process.exit(1)
