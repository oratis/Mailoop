#!/usr/bin/env bash
set -euo pipefail
qa_dir=$(mktemp -d)
qa_pid=
finish() {
  if [[ -n "$qa_pid" ]]; then kill "$qa_pid" 2>/dev/null || true; wait "$qa_pid" 2>/dev/null || true; fi
  rm -rf "$qa_dir"
}
trap finish EXIT
if [[ -n "${MAILOOP_GREENMAIL_JAR:-}" ]]; then
  cp "$MAILOOP_GREENMAIL_JAR" "$qa_dir/server.jar"
else
  curl -fsSL --retry 2 https://repo.maven.apache.org/maven2/com/icegreen/greenmail-standalone/2.1.15/greenmail-standalone-2.1.15.jar -o "$qa_dir/server.jar"
fi
echo "91d58798698cac357f015365240383b936ced2f2a1a9f7db37d9e3e1a31391b1  $qa_dir/server.jar" | shasum -a 256 -c -
keytool -genkeypair -alias mailoop-test -keyalg RSA -storetype PKCS12 -keystore "$qa_dir/test.p12" -storepass mailoop-test -dname "CN=localhost" -ext "SAN=DNS:localhost,IP:127.0.0.1" -validity 1 -noprompt >/dev/null 2>&1
keytool -exportcert -rfc -alias mailoop-test -keystore "$qa_dir/test.p12" -storepass mailoop-test > "$qa_dir/ca.pem"
java -Dgreenmail.setup.test.smtps -Dgreenmail.setup.test.imaps -Dgreenmail.hostname=127.0.0.1 -Dgreenmail.users.login=email -Dgreenmail.users=alice:mailtest@brand.example,bob:mailtest@creator.example -Dgreenmail.tls.keystore.file="$qa_dir/test.p12" -Dgreenmail.tls.keystore.password=mailoop-test -jar "$qa_dir/server.jar" > "$qa_dir/server.log" 2>&1 &
qa_pid=$!
for _ in {1..40}; do
  if ! kill -0 "$qa_pid" 2>/dev/null; then cat "$qa_dir/server.log"; exit 1; fi
  if (exec 3<>/dev/tcp/127.0.0.1/3465) 2>/dev/null; then break; fi
  sleep 0.25
done
NODE_EXTRA_CA_CERTS="$qa_dir/ca.pem" node --import tsx scripts/check-mail.ts
