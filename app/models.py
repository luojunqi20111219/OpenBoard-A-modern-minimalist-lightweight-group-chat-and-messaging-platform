from pydantic import BaseModel, Field
from typing import Optional, List

class LoginData(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    remember_me: bool = True
    device_id: Optional[str] = Field(default=None, max_length=128)
    device_name: Optional[str] = Field(default=None, max_length=120)
    otp: Optional[str] = Field(default=None, min_length=6, max_length=8)

class RegisterData(BaseModel):
    username: str = Field(min_length=1, max_length=64, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=8, max_length=128)
    nickname: Optional[str] = Field(default=None, max_length=64)
    remember_me: bool = True
    device_id: Optional[str] = Field(default=None, max_length=128)
    device_name: Optional[str] = Field(default=None, max_length=120)

class PasswordChangeData(BaseModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

class MessageData(BaseModel):
    content: str = Field(min_length=1, max_length=10000)
    room_id: int = Field(default=0, ge=0)
    receiver: Optional[str] = Field(default=None, max_length=64)
    reply_to: Optional[int] = None
    client_id: Optional[str] = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")

class MessageEditData(BaseModel):
    content: str = Field(min_length=1, max_length=10000)

class MessageReadData(BaseModel):
    room_id: int = Field(default=0, ge=0)
    target_user: Optional[str] = Field(default=None, max_length=64)
    up_to_id: int = Field(ge=1)

class ConversationSettingData(BaseModel):
    conversation_key: str = Field(min_length=3, max_length=140, pattern=r"^(room:\d+|user:[\w.-]+)$")
    is_pinned: bool = False
    is_muted: bool = False

class ForwardMessageData(BaseModel):
    room_id: int = Field(default=0, ge=0)
    receiver: Optional[str] = Field(default=None, max_length=64)

class UserProfileData(BaseModel):
    nickname: Optional[str] = Field(default=None, max_length=64)
    avatar: Optional[str] = Field(default=None, max_length=12000000)

class BlockUserData(BaseModel):
    target_username: str = Field(min_length=1, max_length=64)

class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    is_public: int = 1

class GroupUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=64)

class GroupPermissionUpdate(BaseModel):
    view_mode: int = 0
    speak_mode: int = 0
    black_view: str = Field(default="", max_length=4096)
    black_speak: str = Field(default="", max_length=4096)
    white_view: str = Field(default="", max_length=4096)
    white_speak: str = Field(default="", max_length=4096)

class GroupAvatarUpdate(BaseModel):
    avatar: str = Field(max_length=12000000)

class GroupAdvancedUpdate(BaseModel):
    announcement: str = Field(default="", max_length=2000)
    member_only: bool = False
    join_approval: bool = False

class GroupInviteData(BaseModel):
    username: str = Field(min_length=1, max_length=64)

class GroupRequestActionData(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    action: str = Field(pattern=r"^(accept|reject)$")

class GroupInviteActionData(BaseModel):
    invite_id: int = Field(ge=1)
    action: str = Field(pattern=r"^(accept|reject)$")

class GroupMemberUpdateData(BaseModel):
    role: Optional[str] = Field(default=None, pattern=r"^(member|admin)$")
    muted_until: Optional[str] = Field(default=None, max_length=32)

class AdminAction(BaseModel):
    user_id: Optional[int] = None
    msg_id: Optional[int] = None
    msg_ids: Optional[List[int]] = None
    group_id: Optional[int] = None
    group_ids: Optional[List[int]] = None
    new_password: Optional[str] = None
    filename: Optional[str] = None
    code: Optional[str] = None
    avatar_base64: Optional[str] = None

class PushTokenData(BaseModel):
    push_token: str = Field(min_length=1, max_length=4096)
    device_id: str = Field(min_length=1, max_length=128)
    device_name: Optional[str] = Field(default=None, max_length=120)

class WebDeviceData(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    device_name: Optional[str] = Field(default=None, max_length=120)

class DeviceLogoutData(BaseModel):
    password: str = Field(min_length=1, max_length=128)

class SecurityPreferencesData(BaseModel):
    read_receipts_enabled: bool = True

class TwoFactorConfirmData(BaseModel):
    code: str = Field(min_length=6, max_length=8)

class TwoFactorDisableData(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=6, max_length=8)

class LogoutAllData(BaseModel):
    password: str = Field(min_length=1, max_length=128)

class FavoriteEmojiData(BaseModel):
    emoji: str = Field(min_length=1, max_length=10000)
