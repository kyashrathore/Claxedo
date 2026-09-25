#!/bin/sh
set -eu

case "$(uname -m)" in
  x86_64)
    agent_arch=x64
    droid_arch=x64-baseline
    cursor_sha256=740dd9d6eb5aec36ca90eaedf9fd5e2c489cd674d69b5147b3c2670f02d9776d
    amp_sha256=20f1bcc33741268781a823eaa38e70045e53ae5f9d86d3d6919c93a49188f9fc
    droid_sha256=0b0dd516f357963b12ee80aa589f283d0e850c7dbbcfb529a3334e3b1ec82967
    ;;
  aarch64)
    agent_arch=arm64
    droid_arch=arm64
    cursor_sha256=38d1482c945172926e780206fce8cc51c67dd4f96162bcec680903aa70d80417
    amp_sha256=d6709ea9865d77e5d465912e85f441dacd4797dc48ff48e27dff8244a3623dd1
    droid_sha256=ec7663001f96fcdf55682c91e2a73d0e37a75bab93504cb08d73a9bcd6fd7894
    ;;
  *) exit 1 ;;
esac

cursor_version=2026.09.23-86fc751
curl -fsSL "https://downloads.cursor.com/lab/${cursor_version}/linux/${agent_arch}/agent-cli-package.tar.gz" -o /tmp/cursor-agent.tar.gz
printf '%s  %s\n' "$cursor_sha256" /tmp/cursor-agent.tar.gz | sha256sum -c -
mkdir -p "/root/.local/share/cursor-agent/versions/${cursor_version}" /root/.local/bin
tar -xzf /tmp/cursor-agent.tar.gz --strip-components=1 -C "/root/.local/share/cursor-agent/versions/${cursor_version}"
printf '#!/bin/sh\nexec "%s" --disable-auto-update "$@"\n' "/root/.local/share/cursor-agent/versions/${cursor_version}/cursor-agent" > /root/.local/bin/cursor-agent
chmod 0755 /root/.local/bin/cursor-agent
ln -sf /root/.local/bin/cursor-agent /root/.local/bin/agent

amp_version=0.0.1790308846-g932e8e
curl -fsSL "https://static.ampcode.com/cli/${amp_version}/amp-linux-${agent_arch}.gz" -o /tmp/amp.gz
printf '%s  %s\n' "$amp_sha256" /tmp/amp.gz | sha256sum -c -
mkdir -p /root/.amp/bin
gzip -dc /tmp/amp.gz > /root/.amp/bin/amp
chmod 0755 /root/.amp/bin/amp

droid_version=0.227.0
curl -fsSL "https://downloads.factory.ai/factory-cli/releases/${droid_version}/linux/${droid_arch}/droid" -o /tmp/droid
printf '%s  %s\n' "$droid_sha256" /tmp/droid | sha256sum -c -
install -m 0755 /tmp/droid /root/.local/bin/droid
rm /tmp/cursor-agent.tar.gz /tmp/amp.gz /tmp/droid
