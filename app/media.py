import base64
import io

from PIL import Image, ImageOps


MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024
AVATAR_SIZE = (160, 160)


def normalize_avatar(avatar: str) -> str:
    """Strip image metadata and cap embedded avatars to a small JPEG."""
    if not avatar or not avatar.startswith("data:image"):
        return avatar

    try:
        _, encoded = avatar.split(",", 1)
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid avatar image data") from exc

    if len(raw) > MAX_AVATAR_SOURCE_BYTES:
        raise ValueError("Avatar image is too large")

    try:
        with Image.open(io.BytesIO(raw)) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail(AVATAR_SIZE, Image.Resampling.LANCZOS)
            if image.mode != "RGB":
                background = Image.new("RGB", image.size, "white")
                if image.mode in ("RGBA", "LA"):
                    background.paste(image, mask=image.getchannel("A"))
                else:
                    background.paste(image.convert("RGB"))
                image = background

            output = io.BytesIO()
            image.save(output, format="JPEG", quality=78, optimize=True)
    except Exception as exc:
        raise ValueError("Unsupported avatar image") from exc

    encoded_output = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded_output}"
