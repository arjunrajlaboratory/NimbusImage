#!/usr/bin/env bash
# Check the MCP routing rules of an HAProxy: which backend answers each
# path, the HTTPS redirect, the ACME exemption, and the Girder denies,
# including encoded, // and trailing-slash variants. Exits non-zero if any
# check fails.
#
# Local (deploy/local-haproxy running, see its docker-compose.yaml):
#   nimbusimage-mcp/deploy/local-haproxy/check_routing.sh
# Another deployment (Phase 5, the AWS test environment):
#   HTTPS_BASE=https://test.example HTTP_BASE=http://test.example \
#     INTERNAL_BASE= check_routing.sh
# Run that from outside the VPC: production skips the HTTPS redirect for
# src ${VPC_CIDR}, so the plain-HTTP checks would fail from inside.
#
#   HTTPS_BASE     sent with X-Forwarded-Proto: https (the local stand-in
#                  for TLS; a real TLS frontend ignores the header)
#   HTTP_BASE      plain HTTP, for the redirect checks
#   INTERNAL_BASE  the private-network side; empty skips those checks
#
# The backend is read from X-Nimbus-Backend (local HAProxy only). Without
# it, checks fall back to what each backend answers with: MCP's 401
# challenge, Girder's JSON, the static server's HTML.
set -u

HTTPS_BASE=${HTTPS_BASE:-http://localhost:${HAPROXY_PORT:-8090}}
HTTP_BASE=${HTTP_BASE:-http://localhost:${HAPROXY_PORT:-8090}}
INTERNAL_BASE=${INTERNAL_BASE-http://localhost:${HAPROXY_INTERNAL_PORT:-8091}}

failures=0
checks=0

# request METHOD URL [curl args...] -> sets status, backend, ctype,
# location, deny, challenge
request() {
  local method=$1 url=$2
  shift 2
  local headers
  headers=$(curl -s --path-as-is -o /dev/null -D - -X "$method" \
    --max-time 20 "$@" "$url" | tr -d '\r')
  status=$(awk 'NR==1 {print $2}' <<<"$headers")
  header() { awk -v h="$1" 'tolower($1) == tolower(h)":" \
    {sub(/^[^:]*: */, ""); print; exit}' <<<"$headers"; }
  backend=$(header X-Nimbus-Backend)
  ctype=$(header Content-Type)
  location=$(header Location)
  deny=$(header X-Nimbus-Deny)
  challenge=$(header WWW-Authenticate)
}

https() { request "$1" "$HTTPS_BASE$2" -H 'X-Forwarded-Proto: https' \
  "${@:3}"; }

pass() { checks=$((checks + 1)); }
fail() {
  checks=$((checks + 1)); failures=$((failures + 1))
  echo "FAIL $1: status=$status backend=${backend:-?} deny=${deny:-} \
type=${ctype:-} location=${location:-}"
}

# expect_backend NAME LABEL: the response came from that backend.
expect_backend() {
  local want=$1 label=$2 ok
  if [[ -n $backend ]]; then
    [[ $backend == "$want" ]] && ok=1 || ok=0
  else
    case $want in
      nimbus-mcp) [[ $challenge == *resource_metadata=* ||
                     $ctype == application/json* ]] && ok=1 || ok=0 ;;
      nimbus-girders) [[ $ctype == application/json* ]] && ok=1 || ok=0 ;;
      static-server) [[ $ctype == text/html* ]] && ok=1 || ok=0 ;;
    esac
  fi
  if [[ $ok == 1 && $status != 403 ]]; then pass; else fail "$label"; fi
}

# expect_denied LABEL [RULE]: a 403, and when the proxy names its deny
# rules (X-Nimbus-Deny, local only), from RULE, so one rule cannot pass for
# another.
expect_denied() {
  if [[ $status == 403 && ( -z $deny || -z ${2:-} || $deny == "$2" ) ]]
  then pass; else fail "$1 (want 403${2:+ from $2})"; fi
}

echo "Checking $HTTPS_BASE (plain: $HTTP_BASE, internal: \
${INTERNAL_BASE:-skipped})"

# --- Plain HTTP: redirected to HTTPS, except ACME renewal.
for path in /mcp /.well-known/oauth-protected-resource/mcp \
    /.well-known/oauth-authorization-server \
    /.well-known/openid-configuration /girder/api/v1/system/version; do
  request GET "$HTTP_BASE$path"
  if [[ $status == 30[1278] && $location == https://* ]]; then pass
  else fail "plain HTTP $path redirects to https"; fi
done
request GET "$HTTP_BASE/.well-known/acme-challenge/phase2-test"
[[ $status == 200 ]] && pass || fail "ACME challenge served over HTTP"

# --- The MCP service.
for path in /mcp '/mcp?x=1'; do
  https POST "$path" -H 'Content-Type: application/json' -d '{}'
  if [[ $status == 401 &&
        $challenge == *'/.well-known/oauth-protected-resource/mcp"'* ]]
  then expect_backend nimbus-mcp "POST $path"
  else fail "POST $path is MCP's 401 with the metadata challenge"; fi
done
https GET /.well-known/oauth-protected-resource/mcp
[[ $status == 200 ]] && expect_backend nimbus-mcp "resource metadata" ||
  fail "resource metadata is 200"
https POST /mcp/ -d '{}'
if [[ $status == 308 && $location == /mcp ]]; then pass
else fail "POST /mcp/ is a 308 to /mcp"; fi

# --- OAuth authorization-server metadata: Girder's, never index.html.
# 404 while mcp_oauth.enabled is off (and always for openid-configuration,
# which Girder does not serve: an HTML error page), JSON 200 once on.
for path in /.well-known/oauth-authorization-server \
    /.well-known/openid-configuration; do
  https GET "$path"
  # Without the backend header: Girder's 404 is HTML or JSON, never the MCP
  # server's text/plain one.
  if [[ $status == 404 || ($status == 200 && $ctype == application/json*) ]]
  then
    if [[ -n $backend && $backend != nimbus-girders ]] ||
       [[ -z $backend && $ctype == text/plain* ]]; then
      fail "$path comes from Girder"
    else pass; fi
  else fail "$path comes from Girder"; fi
done

# --- Anything else is the static frontend, including near misses of the
# routed paths (no path_beg /.well-known/ rule).
for path in /foo /.well-known/foo /MCP /%6dcp //mcp \
    /.well-known/openid-configuration/ \
    /.well-known/oauth-protected-resource/mcp/extra; do
  https GET "$path"
  expect_backend static-server "GET $path"
done

# --- Public side: the OAuth endpoints clients call reach Girder.
for path in authorize token revoke; do
  https GET "/girder/api/v1/mcp_oauth/$path"
  # An answer from Girder that is not a deny: no answer at all fails too
  if [[ -n $status && $status != 403 && $ctype != text/html* &&
        ( -z $backend || $backend == nimbus-girders ) ]]; then pass
  else fail "mcp_oauth/$path reachable"; fi
done

# --- Public side: introspection is refused, however it is spelled.
for path in /girder/api/v1/mcp_oauth/introspect \
    /girder/api/v1/mcp_oauth/introspect/ \
    /girder/api/v1/mcp_oauth/%69ntrospect \
    /girder/api/v1/mcp_oauth/INTROSPECT \
    /girder/api/v1//mcp_oauth/introspect \
    /girder/api//v1/mcp_oauth/introspect \
    //girder/api/v1/mcp_oauth/introspect \
    /girder/api/v1/mcp_oauth%2Fintrospect \
    '/girder/api/v1/mcp_oauth/introspect?x=1' \
    /girder/api/v1/mcp_oauth/introspect%3Bx; do
  https POST "$path" -d 'token=x'
  expect_denied "public POST $path" introspect
done

# --- Public side, local HAProxy only: the rest of Girder is refused.
if [[ -n $INTERNAL_BASE ]]; then
  for path in /girder /girder/ /girder/api/v1/system/version \
      //girder/api/v1/system/version /girder/api/v1/user/me \
      /girder/api/v1/mcp_oauth/token/ /girder/api/v1/mcp_oauth/tokens; do
    https GET "$path"
    expect_denied "public GET $path" local-girder
  done
fi

# --- Private side: Girder answers, introspection included.
if [[ -n $INTERNAL_BASE ]]; then
  for path in /girder/api/v1/system/version \
      //girder/api/v1/system/version; do
    request GET "$INTERNAL_BASE$path" -H 'X-Forwarded-Proto: https'
    [[ $status == 200 ]] && expect_backend nimbus-girders "internal $path" ||
      fail "internal $path is 200"
  done
  # No secret: Girder's 404 (OAuth off or a wrong secret), not the proxy's
  # 403.
  request POST "$INTERNAL_BASE/girder/api/v1/mcp_oauth/introspect" \
    -H 'X-Forwarded-Proto: https' -d 'token=x'
  [[ $status == 404 ]] && expect_backend nimbus-girders "internal introspect" ||
    fail "internal introspect reaches Girder"
fi

echo "$((checks - failures))/$checks checks passed"
[[ $failures == 0 ]]
