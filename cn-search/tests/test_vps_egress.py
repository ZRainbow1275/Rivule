"""Pure rule-planning tests; real kernel and traffic checks belong to VPS acceptance."""

import copy
import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("vps_egress", Path(__file__).parents[1] / "deploy" / "vps-egress.py")
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


class FirewallPlanTests(unittest.TestCase):
    def setUp(self):
        self.state = {"nftables": [
            {"chain": {"name": "forward", "policy": "drop"}},
            {"chain": {"name": "input", "policy": "drop"}},
            {"rule": {"chain": "forward", "handle": 23, "comment": "existing NetBird"}},
        ]}

    def installed(self):
        self.state["nftables"].extend([
            {"chain": {"name": egress.CHAIN, "comment": egress.TAG}},
            {"rule": {"chain": "forward", "handle": 42, "comment": egress.TAG}},
        ])

    def test_apply_is_scoped_and_blocks_nonpublic_before_public_web(self):
        before = copy.deepcopy(self.state)
        batch = egress.commands("apply", self.state)
        self.assertEqual(before, self.state)
        self.assertIn('forward iifname "rv-search" jump rivule_search_out', batch)
        self.assertIn('oifname "ens3" ip daddr { 8.8.8.8, 1.1.1.1 } udp dport 53', batch)
        self.assertIn('meta nfproto ipv4 oifname "ens3" tcp dport { 80, 443 }', batch)
        self.assertLess(batch.index(".nonpublic"), batch.index(".web"))
        self.assertNotIn("flush ruleset", batch)
        self.assertNotIn("delete table", batch)
        self.assertNotIn(" input ", batch)
        self.assertEqual(batch.count(" forward "), 1)

    def test_reapply_keeps_one_jump_and_replaces_only_own_chain(self):
        self.installed()
        batch = egress.commands("apply", self.state)
        self.assertNotIn("add chain", batch)
        self.assertNotIn(" forward ", batch)
        self.assertEqual(batch.count("flush chain"), 1)

    def test_remove_preserves_existing_rules(self):
        self.installed()
        batch = egress.commands("remove", self.state)
        self.assertIn("forward handle 42", batch)
        self.assertNotIn("handle 23", batch)
        self.assertIn("delete chain inet secure_remote_v1 rivule_search_out", batch)
        self.assertNotIn("delete table", batch)

    def test_remove_absent_is_noop(self):
        self.assertEqual(egress.commands("remove", self.state), "")

    def test_other_owner_chain_is_not_flushed(self):
        self.state["nftables"].append({"chain": {"name": egress.CHAIN, "comment": "other owner"}})
        for action in ("apply", "remove"):
            with self.assertRaisesRegex(ValueError, "another configuration"):
                egress.commands(action, self.state)

    def test_duplicate_jump_is_rejected(self):
        self.installed()
        self.state["nftables"].append({"rule": {"chain": "forward", "handle": 43, "comment": egress.TAG}})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            egress.commands("apply", self.state)

    def test_changed_host_policy_is_not_redefined(self):
        self.state["nftables"][0]["chain"]["policy"] = "accept"
        with self.assertRaisesRegex(ValueError, "default-drop"):
            egress.commands("apply", self.state)

    def test_remove_handle_cannot_inject_configuration(self):
        self.installed()
        self.state["nftables"][-1]["rule"]["handle"] = "42; flush ruleset"
        with self.assertRaisesRegex(ValueError, "handle"):
            egress.commands("remove", self.state)

    def test_vps_lifecycle_does_not_restore_before_firewall_gate(self):
        base = Path(__file__).parents[1]
        overlay = (base / "compose.vps.yaml").read_text(encoding="utf-8")
        service = (base / "deploy" / "rivule-cn-search.service").read_text(encoding="utf-8")
        self.assertIn("restart: on-failure", overlay)
        self.assertIn("PartOf=secure-remote-firewall.service docker.service", service)
        self.assertIn("After=docker.service secure-remote-firewall.service", service)
        self.assertIn("ExecStartPre=/usr/bin/python3 /usr/local/libexec/rivule-cn-search-egress apply", service)
        self.assertIn("ExecStopPost=/usr/bin/python3 /usr/local/libexec/rivule-cn-search-egress remove", service)

    def test_chromium_selection_survives_service_restart_without_overwriting_moli_image(self):
        base = Path(__file__).parents[1]
        compose = (base / "compose.yaml").read_text(encoding="utf-8")
        service = (base / "deploy" / "rivule-cn-search.service").read_text(encoding="utf-8")
        chromium = (base / "compose.chromium.yaml").read_text(encoding="utf-8")
        dropin = (base / "deploy" / "chromium.conf").read_text(encoding="utf-8")
        self.assertIn("no-new-privileges:true", compose)
        self.assertNotIn("no-new-privileges", chromium)  # Inherited once; duplicate list items fail Compose validation.
        self.assertIn("seccomp=./chromium-seccomp.json", chromium)
        self.assertIn('Environment="COMPOSE_FILE=', service)
        self.assertIn("compose.vps.yaml:/opt/rivule-cn-search/compose.chromium.yaml", dropin)
        self.assertIn("-regional-worker:chromium-1.61.0", chromium)
        for line in service.splitlines():
            if line.startswith(("ExecStart=", "ExecStop=")):
                self.assertIn("compose -p rivule-cn-search", line)
                self.assertNotIn(" -f ", line)

    def test_chromium_namespace_sandbox_stays_capless_and_fail_closed(self):
        base = Path(__file__).parents[1]
        profile = json.loads((base / "chromium-seccomp.json").read_text(encoding="utf-8"))
        self.assertEqual(profile["defaultAction"], "SCMP_ACT_ERRNO")
        allowed = {name for rule in profile["syscalls"] if rule["action"] == "SCMP_ACT_ALLOW" and not rule.get("args") and not rule.get("includes") and not rule.get("excludes") for name in rule["names"]}
        self.assertTrue({"clone", "setns", "unshare", "chroot"}.issubset(allowed))
        compose = (base / "compose.yaml").read_text(encoding="utf-8")
        chromium = (base / "compose.chromium.yaml").read_text(encoding="utf-8")
        self.assertIn("cap_drop: [ALL]", compose)
        self.assertIn("no-new-privileges:true", compose)
        self.assertIn("seccomp=./chromium-seccomp.json", chromium)
        self.assertNotIn("cap_add:", compose + chromium)


if __name__ == "__main__":
    unittest.main()
