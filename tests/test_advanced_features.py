import io
import os
import tempfile
import time
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from app.config import Config
from app.database import patch_db
from app.main import app
from app.security import _totp_code


class AdvancedFeatureIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        Config.DB_FILE = os.path.join(cls.temp_dir.name, "test.db")
        Config.UPLOAD_DIR = os.path.join(cls.temp_dir.name, "uploads")
        os.makedirs(Config.UPLOAD_DIR, exist_ok=True)
        patch_db()
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.temp_dir.cleanup()

    def register(self, username):
        response = self.client.post(
            "/api/register",
            json={
                "username": username,
                "password": "Test-pass-123",
                "device_id": f"device-{username}",
                "device_name": "Integration test",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return {"Authorization": response.json()["token"]}

    def test_messages_groups_security_and_uploads(self):
        owner = self.register("feature_owner")
        member = self.register("feature_member")
        invited = self.register("feature_invited")

        message_ids = []
        for index in range(55):
            response = self.client.post(
                "/api/messages",
                headers=owner,
                json={
                    "content": f"pagination message {index}",
                    "room_id": 0,
                    "client_id": f"feature-client-{index:03d}",
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            message_ids.append(response.json()["id"])

        latest = self.client.get("/api/messages?room_id=0&limit=50", headers=owner)
        self.assertEqual(latest.status_code, 200, latest.text)
        self.assertEqual(len(latest.json()["data"]), 50)
        self.assertTrue(latest.json()["pagination"]["has_more"])
        before_id = latest.json()["pagination"]["next_before_id"]
        older = self.client.get(f"/api/messages?room_id=0&limit=50&before_id={before_id}", headers=owner)
        self.assertEqual(len(older.json()["data"]), 5)

        duplicate = self.client.post(
            "/api/messages",
            headers=owner,
            json={"content": "ignored duplicate", "room_id": 0, "client_id": "feature-client-054"},
        )
        self.assertTrue(duplicate.json()["duplicate"])
        self.assertEqual(duplicate.json()["id"], message_ids[-1])

        edited = self.client.put(
            f"/api/messages/{message_ids[-1]}", headers=owner, json={"content": "edited searchable text"}
        )
        self.assertEqual(edited.status_code, 200, edited.text)
        searched = self.client.get("/api/messages/search?q=searchable&room_id=0", headers=owner)
        self.assertEqual(searched.json()["data"][0]["id"], message_ids[-1])
        self.assertTrue(searched.json()["data"][0]["edited"])

        read = self.client.post(
            "/api/messages/read",
            headers=member,
            json={"room_id": 0, "up_to_id": message_ids[-1]},
        )
        self.assertEqual(read.status_code, 200, read.text)
        receipts = self.client.get(f"/api/messages/{message_ids[-1]}/reads", headers=owner)
        self.assertEqual(receipts.json()["data"][0]["username"], "feature_member")

        self.assertEqual(
            self.client.post(f"/api/favorites/messages/{message_ids[-1]}", headers=member).status_code,
            200,
        )
        favorites = self.client.get("/api/favorites/messages", headers=member)
        self.assertEqual(favorites.json()["data"][0]["id"], message_ids[-1])
        pin = self.client.put(
            "/api/conversation-settings",
            headers=member,
            json={"conversation_key": "room:0", "is_pinned": True, "is_muted": False},
        )
        self.assertEqual(pin.status_code, 200, pin.text)
        settings = self.client.get("/api/conversation-settings", headers=member).json()["data"]
        self.assertEqual(settings[0]["is_pinned"], 1)

        group = self.client.post("/api/groups", headers=owner, json={"name": "Feature group"})
        self.assertEqual(group.status_code, 200, group.text)
        group_id = group.json()["group_id"]
        advanced = self.client.put(
            f"/api/groups/{group_id}/advanced",
            headers=owner,
            json={"announcement": "Rules", "member_only": True, "join_approval": True},
        )
        self.assertEqual(advanced.status_code, 200, advanced.text)
        join = self.client.post(f"/api/groups/{group_id}/join", headers=member)
        self.assertTrue(join.json()["pending"])
        accepted = self.client.post(
            f"/api/groups/{group_id}/join-requests/respond",
            headers=owner,
            json={"username": "feature_member", "action": "accept"},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        invite = self.client.post(
            f"/api/groups/{group_id}/invite",
            headers=member,
            json={"username": "feature_invited"},
        )
        self.assertEqual(invite.status_code, 200, invite.text)
        invites = self.client.get("/api/group-invites", headers=invited).json()["data"]
        accepted_invite = self.client.post(
            "/api/group-invites/respond",
            headers=invited,
            json={"invite_id": invites[0]["id"], "action": "accept"},
        )
        self.assertEqual(accepted_invite.status_code, 200, accepted_invite.text)
        members = self.client.get(f"/api/groups/{group_id}/members", headers=owner).json()["data"]
        self.assertEqual({item["username"] for item in members}, {"feature_owner", "feature_member", "feature_invited"})
        audit = self.client.get(f"/api/groups/{group_id}/audit", headers=owner)
        self.assertGreaterEqual(len(audit.json()["data"]), 4)

        preferences = self.client.put(
            "/api/user/security/preferences", headers=owner, json={"read_receipts_enabled": False}
        )
        self.assertEqual(preferences.status_code, 200, preferences.text)
        setup = self.client.post(
            "/api/user/two-factor/setup", headers=owner, json={"password": "Test-pass-123"}
        )
        secret = setup.json()["secret"]
        code = _totp_code(secret, time.time())
        confirmed = self.client.post("/api/user/two-factor/confirm", headers=owner, json={"code": code})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        without_code = self.client.post(
            "/api/login", json={"username": "feature_owner", "password": "Test-pass-123"}
        )
        self.assertEqual(without_code.status_code, 401)
        self.assertEqual(without_code.headers.get("X-OpenBoard-2FA"), "required")
        with_code = self.client.post(
            "/api/login",
            json={"username": "feature_owner", "password": "Test-pass-123", "otp": _totp_code(secret, time.time())},
        )
        self.assertEqual(with_code.status_code, 200, with_code.text)
        history = self.client.get("/api/user/login-history", headers=owner)
        self.assertGreaterEqual(len(history.json()["data"]), 3)

        image_buffer = io.BytesIO()
        Image.new("RGB", (1200, 800), "#336699").save(image_buffer, "PNG")
        uploaded = self.client.post(
            "/api/upload",
            headers=owner,
            files={"file": ("large.png", image_buffer.getvalue(), "image/png")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertTrue(uploaded.json()["thumbnail_url"].endswith(".thumb.jpg"))


if __name__ == "__main__":
    unittest.main()
