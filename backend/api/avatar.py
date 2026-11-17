from fastapi import APIRouter, HTTPException
import httpx

from backend.config import ANAM_API_KEY, ANAM_AVATAR_ID

router = APIRouter()


@router.get("/avatar-token")
async def get_avatar_token():

    if not ANAM_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ANAM_API_KEY is not configured"
        )

    if not ANAM_AVATAR_ID:
        raise HTTPException(
            status_code=500,
            detail="ANAM_AVATAR_ID is not configured"
        )

    payload = {
        "personaConfig": {
            "avatarId": ANAM_AVATAR_ID,
            "enableAudioPassthrough": True,
        }
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ANAM_API_KEY}",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://api.anam.ai/v1/auth/session-token",
                json=payload,
                headers=headers,
            )

        if response.status_code != 200:
            print("\n========== ANAM API ERROR ==========")
            print("Status:", response.status_code)
            print("Response:", response.text)
            print("====================================\n")

            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Anam session token generation failed",
                    "anam_status": response.status_code,
                    "anam_response": response.text,
                },
            )

        data = response.json()

        session_token = data.get("sessionToken")

        if not session_token:
            raise HTTPException(
                status_code=502,
                detail=f"Session token missing in Anam response: {data}",
            )

        return {
            "session_token": session_token,
            "avatar_id": ANAM_AVATAR_ID,
        }

    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Unable to connect to Anam API: {str(exc)}",
        )