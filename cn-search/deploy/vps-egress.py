"""Manage only Rivule's extension to this VPS's existing default-drop firewall."""

import argparse
import json
import subprocess


NFT = "/usr/sbin/nft"
TABLE = "inet secure_remote_v1"
CHAIN = "rivule_search_out"
TAG = "rivule-cn-search-egress"
BRIDGE = "rv-search"
NONPUBLIC = "0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4"


def commands(action, state):
    objects = state.get("nftables", [])
    chain = next((item["chain"] for item in objects if item.get("chain", {}).get("name") == CHAIN), None)
    jumps = [item["rule"] for item in objects if item.get("rule", {}).get("chain") == "forward" and item["rule"].get("comment") == TAG]
    if chain is not None and chain.get("comment") != TAG:
        raise ValueError("The Rivule chain name is already owned by another configuration.")
    if len(jumps) > 1:
        raise ValueError("Duplicate Rivule jump rules require operator review.")
    batch = []
    if action == "remove":
        for rule in jumps:
            handle = rule.get("handle")
            if type(handle) is not int or handle < 1:
                raise ValueError("Invalid nftables rule handle.")
            batch.append(f"delete rule {TABLE} forward handle {handle}")
        if chain:
            batch.extend([f"flush chain {TABLE} {CHAIN}", f"delete chain {TABLE} {CHAIN}"])
        return "\n".join(batch) + ("\n" if batch else "")
    if not any(item.get("chain", {}).get("name") == "forward" and item["chain"].get("policy") == "drop" for item in objects):
        raise ValueError("Expected the existing default-drop forward chain; leave the host policy unchanged.")
    if chain is None:
        batch.append(f'add chain {TABLE} {CHAIN} {{ comment "{TAG}"; }}')
    batch.extend([
        f"flush chain {TABLE} {CHAIN}",
        f'add rule {TABLE} {CHAIN} ip daddr {{ {NONPUBLIC} }} counter drop comment "{TAG}.nonpublic"',
        f'add rule {TABLE} {CHAIN} oifname "ens3" ip daddr {{ 8.8.8.8, 1.1.1.1 }} udp dport 53 counter accept comment "{TAG}.dns-udp"',
        f'add rule {TABLE} {CHAIN} oifname "ens3" ip daddr {{ 8.8.8.8, 1.1.1.1 }} tcp dport 53 counter accept comment "{TAG}.dns-tcp"',
        f'add rule {TABLE} {CHAIN} meta nfproto ipv4 oifname "ens3" tcp dport {{ 80, 443 }} counter accept comment "{TAG}.web"',
        f'add rule {TABLE} {CHAIN} counter drop comment "{TAG}.other"',
    ])
    if not jumps:
        batch.append(f'add rule {TABLE} forward iifname "{BRIDGE}" jump {CHAIN} comment "{TAG}"')
    return "\n".join(batch) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("apply", "remove"))
    parser.add_argument("--check", action="store_true", help="Ask the real kernel to validate the atomic batch without changing rules.")
    args = parser.parse_args()
    current = subprocess.run([NFT, "-j", "list", "table", "inet", "secure_remote_v1"], capture_output=True, text=True)
    if current.returncode:
        if args.action == "remove" and "No such file or directory" in current.stderr:
            return
        raise SystemExit(current.stderr.strip() or "Cannot read the existing host firewall.")
    try:
        batch = commands(args.action, json.loads(current.stdout))
    except (ValueError, KeyError) as error:
        raise SystemExit(str(error)) from error
    if batch:
        subprocess.run([NFT, *(("--check",) if args.check else ()), "--file", "-"], input=batch, text=True, check=True)
    print(f"Rivule firewall {args.action}: {'validated only' if args.check else 'complete'}")


if __name__ == "__main__":
    main()
