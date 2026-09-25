from pathlib import Path
from uuid import UUID, uuid4
from datetime import datetime
from backend.config import BASE_DIR, VECTOR_STORE_DIR
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel, HttpUrl
from sqlalchemy.orm import Session

from backend.core.security import get_current_admin
from backend.db.database import get_db
from backend.db.models import KnowledgeDocument

from backend.ingestion.ingest import IngestionService


# ==================================================
# CONFIG
# ==================================================

router = APIRouter(
    prefix="/knowledge",
    tags=["Knowledge Base"],
)


# ==================================================
# PATHS
# ==================================================



UPLOAD_DIR = BASE_DIR / "uploads" / "knowledge"

UPLOAD_DIR.mkdir(
    parents=True,
    exist_ok=True,
)


# ==================================================
# INGESTION SERVICE
# ==================================================

def get_ingestion_service():

    return IngestionService(
        vector_store_path=str(
            VECTOR_STORE_DIR
        )
    )


# ==================================================
# URL REQUEST
# ==================================================

class KnowledgeURLRequest(BaseModel):

    title: str | None = None

    url: HttpUrl


# ==================================================
# BACKGROUND FILE INGESTION
# ==================================================

def process_file_ingestion(
    document_id: UUID,
):
    """
    Background task for file ingestion.
    """

    from backend.db.database import SessionLocal

    db = SessionLocal()

    try:

        document = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id == document_id
            )
            .first()
        )

        if not document:
            return

        document.status = "processing"
        document.error_message = None

        db.commit()

        try:

            ingestion_service = (
                get_ingestion_service()
            )

            chunk_count = (
                ingestion_service.ingest_file(
                    document
                )
            )

            document.status = "indexed"

            document.chunk_count = (
                chunk_count
            )

            document.error_message = None

            document.indexed_at = (
                datetime.utcnow()
            )

            db.commit()

        except Exception as e:

            db.rollback()

            document = (
                db.query(KnowledgeDocument)
                .filter(
                    KnowledgeDocument.id
                    == document_id
                )
                .first()
            )

            if document:

                document.status = "failed"

                document.error_message = str(e)

                db.commit()

    finally:

        db.close()


# ==================================================
# BACKGROUND URL INGESTION
# ==================================================

def process_url_ingestion(
    document_id: UUID,
):
    """
    Background task for URL ingestion.
    """

    from backend.db.database import SessionLocal

    db = SessionLocal()

    try:

        document = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id == document_id
            )
            .first()
        )

        if not document:
            return

        document.status = "processing"
        document.error_message = None

        db.commit()

        try:

            ingestion_service = (
                get_ingestion_service()
            )

            chunk_count = (
                ingestion_service.ingest_url(
                    document
                )
            )

            document.status = "indexed"

            document.chunk_count = (
                chunk_count
            )

            document.error_message = None

            document.indexed_at = (
                datetime.utcnow()
            )

            db.commit()

        except Exception as e:

            db.rollback()

            document = (
                db.query(KnowledgeDocument)
                .filter(
                    KnowledgeDocument.id
                    == document_id
                )
                .first()
            )

            if document:

                document.status = "failed"

                document.error_message = str(e)

                db.commit()

    finally:

        db.close()


# ==================================================
# UPLOAD FILE
# ==================================================

@router.post(
    "/file",
    status_code=status.HTTP_202_ACCEPTED,
)
async def upload_knowledge_file(
    background_tasks: BackgroundTasks,

    file: UploadFile = File(...),

    db: Session = Depends(get_db),

    admin=Depends(get_current_admin),
):
    """
    Upload a document to the knowledge base.

    The file is saved first and ingestion runs
    in the background.
    """

    if not file.filename:

        raise HTTPException(
            status_code=400,
            detail="File name is required.",
        )

    original_filename = Path(
        file.filename
    ).name

    extension = Path(
        original_filename
    ).suffix.lower()

    allowed_extensions = {
        ".pdf",
        ".docx",
        ".txt",
        ".md",
        ".html",
        ".htm",
    }

    if extension not in allowed_extensions:

        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported file type. "
                "Supported types: "
                "PDF, DOCX, TXT, MD, HTML."
            ),
        )

    # ----------------------------------------------
    # CREATE DOCUMENT ID
    # ----------------------------------------------

    document_id = uuid4()

    # ----------------------------------------------
    # CREATE DOCUMENT DIRECTORY
    # ----------------------------------------------

    document_dir = (
        UPLOAD_DIR / str(document_id)
    )

    document_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    file_path = (
        document_dir / original_filename
    )

    # ----------------------------------------------
    # SAVE FILE
    # ----------------------------------------------

    try:

        with file_path.open("wb") as buffer:

            while True:

                chunk = await file.read(1024 * 1024)

                if not chunk:
                    break

                buffer.write(chunk)

    except Exception as e:

        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to save uploaded file: {str(e)}"
            ),
        )

    # ----------------------------------------------
    # CREATE DATABASE RECORD
    # ----------------------------------------------

    document = KnowledgeDocument(
        id=document_id,

        title=Path(
            original_filename
        ).stem,

        source_type="file",

        source_url=None,

        file_path=str(
            file_path
        ),

        status="pending",

        error_message=None,

        chunk_count=0,
    )

    db.add(document)

    db.commit()

    db.refresh(document)

    # ----------------------------------------------
    # START BACKGROUND INGESTION
    # ----------------------------------------------

    background_tasks.add_task(
        process_file_ingestion,
        document.id,
    )

    # ----------------------------------------------
    # RESPONSE
    # ----------------------------------------------

    return {
        "message": "File uploaded successfully.",
        "document_id": str(document.id),
        "status": document.status,
        "title": document.title,
    }


# ==================================================
# ADD URL
# ==================================================

@router.post(
    "/url",
    status_code=status.HTTP_202_ACCEPTED,
)
def add_knowledge_url(
    request: KnowledgeURLRequest,

    background_tasks: BackgroundTasks,

    db: Session = Depends(get_db),

    admin=Depends(get_current_admin),
):
    """
    Add one URL to the knowledge base.

    Only this URL will be scraped.
    """

    url = str(request.url)

    title = (
        request.title.strip()
        if request.title
        else url
    )

    # ----------------------------------------------
    # CREATE DATABASE RECORD
    # ----------------------------------------------

    document = KnowledgeDocument(
        id=uuid4(),

        title=title,

        source_type="url",

        source_url=url,

        file_path=None,

        status="pending",

        error_message=None,

        chunk_count=0,
    )

    db.add(document)

    db.commit()

    db.refresh(document)

    # ----------------------------------------------
    # START BACKGROUND INGESTION
    # ----------------------------------------------

    background_tasks.add_task(
        process_url_ingestion,
        document.id,
    )

    # ----------------------------------------------
    # RESPONSE
    # ----------------------------------------------

    return {
        "message": "URL added successfully.",
        "document_id": str(document.id),
        "status": document.status,
        "title": document.title,
        "source_url": document.source_url,
    }


# ==================================================
# GET ALL KNOWLEDGE DOCUMENTS
# ==================================================

@router.get("")
def get_knowledge_documents(
    db: Session = Depends(get_db),

    admin=Depends(get_current_admin),
):
    """
    Return all knowledge documents.
    """

    documents = (
        db.query(KnowledgeDocument)
        .order_by(
            KnowledgeDocument.created_at.desc()
        )
        .all()
    )

    return {
        "items": documents,
        "total": len(documents),
    }


# ==================================================
# GET SINGLE KNOWLEDGE DOCUMENT
# ==================================================

@router.get("/{document_id}")
def get_knowledge_document(
    document_id: UUID,

    db: Session = Depends(get_db),

    admin=Depends(get_current_admin),
):
    """
    Return one knowledge document.
    """

    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id
        )
        .first()
    )

    if not document:

        raise HTTPException(
            status_code=404,
            detail="Knowledge document not found.",
        )

    return document


# ==================================================
# REINDEX
# ==================================================

@router.post(
    "/{document_id}/reindex",
    status_code=status.HTTP_202_ACCEPTED,
)
def reindex_knowledge_document(
    document_id: UUID,

    background_tasks: BackgroundTasks,

    db: Session = Depends(get_db),

    admin=Depends(get_current_admin),
):
    """
    Delete the document's existing Chroma vectors
    and ingest it again.
    """

    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id
        )
        .first()
    )

    if not document:

        raise HTTPException(
            status_code=404,
            detail="Knowledge document not found.",
        )

    # ----------------------------------------------
    # CHECK STATUS
    # ----------------------------------------------

    if document.status == "processing":

        raise HTTPException(
            status_code=409,
            detail=(
                "Document is already being processed."
            ),
        )

    # ----------------------------------------------
    # MARK PROCESSING
    # ----------------------------------------------

    document.status = "processing"

    document.error_message = None

    db.commit()

    # ----------------------------------------------
    # BACKGROUND REINDEX
    # ----------------------------------------------

    if document.source_type == "file":

        background_tasks.add_task(
            process_file_reindex,
            document.id,
        )

    elif document.source_type == "url":

        background_tasks.add_task(
            process_url_reindex,
            document.id,
        )

    else:

        document.status = "failed"

        document.error_message = (
            "Unknown source type."
        )

        db.commit()

        raise HTTPException(
            status_code=400,
            detail="Unknown source type.",
        )

    return {
        "message": "Re-indexing started.",
        "document_id": str(
            document.id
        ),
        "status": "processing",
    }


# ==================================================
# FILE REINDEX BACKGROUND TASK
# ==================================================

def process_file_reindex(
    document_id: UUID,
):
    from backend.db.database import SessionLocal

    db = SessionLocal()

    try:

        document = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id == document_id
            )
            .first()
        )

        if not document:
            return

        try:

            ingestion_service = (
                get_ingestion_service()
            )

            # --------------------------------------
            # REMOVE OLD VECTORS
            # --------------------------------------

            ingestion_service.delete_vectors(
                document.id
            )

            # --------------------------------------
            # INGEST AGAIN
            # --------------------------------------

            chunk_count = (
                ingestion_service.ingest_file(
                    document
                )
            )

            document.status = "indexed"

            document.chunk_count = chunk_count

            document.error_message = None

            document.indexed_at = (
                datetime.utcnow()
            )

            db.commit()

        except Exception as e:

            db.rollback()

            document = (
                db.query(KnowledgeDocument)
                .filter(
                    KnowledgeDocument.id == document_id
                )
                .first()
            )

            if document:

                document.status = "failed"

                document.error_message = str(e)

                db.commit()

    finally:

        db.close()


# ==================================================
# URL REINDEX BACKGROUND TASK
# ==================================================

def process_url_reindex(
    document_id: UUID,
):
    from backend.db.database import SessionLocal

    db = SessionLocal()

    try:

        document = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id == document_id
            )
            .first()
        )

        if not document:
            return

        try:

            ingestion_service = (
                get_ingestion_service()
            )

            # --------------------------------------
            # REMOVE OLD VECTORS
            # --------------------------------------

            ingestion_service.delete_vectors(
                document.id
            )

            # --------------------------------------
            # SCRAPE + INGEST AGAIN
            # --------------------------------------

            chunk_count = (
                ingestion_service.ingest_url(
                    document
                )
            )

            document.status = "indexed"

            document.chunk_count = chunk_count

            document.error_message = None

            document.indexed_at = (
                datetime.utcnow()
            )

            db.commit()

        except Exception as e:

            db.rollback()

            document = (
                db.query(KnowledgeDocument)
                .filter(
                    KnowledgeDocument.id == document_id
                )
                .first()
            )

            if document:

                document.status = "failed"

                document.error_message = str(e)

                db.commit()

    finally:

        db.close()


# ==================================================
# DELETE KNOWLEDGE DOCUMENT
# ==================================================

@router.delete(
    "/{document_id}",
)
def delete_knowledge_document(
    document_id: UUID,

    db: Session = Depends(get_db),

    admin=Depends(get_current_admin),
):
    """
    Delete a knowledge document from:

    1. Chroma
    2. PostgreSQL
    3. Uploaded file
    """

    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id
        )
        .first()
    )

    if not document:

        raise HTTPException(
            status_code=404,
            detail="Knowledge document not found.",
        )

    if document.status == "processing":

        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot delete a document "
                "while it is being processed."
            ),
        )

    # ----------------------------------------------
    # DELETE CHROMA VECTORS
    # ----------------------------------------------

    try:

        ingestion_service = (
            get_ingestion_service()
        )

        ingestion_service.delete_vectors(
            document.id
        )

    except Exception as e:

        raise HTTPException(
            status_code=500,
            detail=(
                "Failed to delete document "
                f"vectors: {str(e)}"
            ),
        )

    # ----------------------------------------------
    # DELETE FILE
    # ----------------------------------------------

    if document.file_path:

        file_path = Path(
            document.file_path
        )

        try:

            if file_path.exists():

                file_path.unlink()

            # Remove empty document directory
            if (
                file_path.parent.exists()
                and not any(
                    file_path.parent.iterdir()
                )
            ):
                file_path.parent.rmdir()

        except Exception as e:

            # Vectors have already been deleted,
            # so report the file deletion problem.
            raise HTTPException(
                status_code=500,
                detail=(
                    "Vectors were deleted, "
                    "but the uploaded file "
                    f"could not be deleted: {str(e)}"
                ),
            )

    # ----------------------------------------------
    # DELETE DATABASE RECORD
    # ----------------------------------------------

    db.delete(document)

    db.commit()

    return {
        "message": (
            "Knowledge document deleted successfully."
        ),
        "document_id": str(document_id),
    }