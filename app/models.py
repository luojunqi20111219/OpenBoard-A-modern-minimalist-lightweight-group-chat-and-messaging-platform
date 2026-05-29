from pydantic import BaseModel
from typing import Optional, List

class LoginData(BaseModel):
    username: str
    password: str

class RegisterData(BaseModel):
    username: str
    password: str
    nickname: Optional[str] = None

class PasswordChangeData(BaseModel):
    old_password: str
    new_password: str

class MessageData(BaseModel):
    content: str
    room_id: int = 0
    receiver: Optional[str] = None
    reply_to: Optional[int] = None

class UserProfileData(BaseModel):
    nickname: Optional[str] = None
    avatar: Optional[str] = None

class BlockUserData(BaseModel):
    target_username: str

class GroupCreate(BaseModel):
    name: str
    is_public: int = 1

class GroupUpdate(BaseModel):
    name: str

class GroupPermissionUpdate(BaseModel):
    view_mode: int = 0
    speak_mode: int = 0
    black_view: str = ""
    black_speak: str = ""
    white_view: str = ""
    white_speak: str = ""

class GroupAvatarUpdate(BaseModel):
    avatar: str

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
