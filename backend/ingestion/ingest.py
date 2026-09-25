from datetime import datetime
from pathlib import Path

from langchain_core.documents import Document

from backend.ingestion.extract import extract_text_from_file
from backend.ingestion.scrape import scrape_single_url
from backend.ingestion.chunk import split_docs
from backend.ingestion.embedding import EmbeddingManager
from backend.ingestion.vector_store import VectorDBManager


class IngestionService:

    def __init__(
        self,
        vector_store_path: str,
    ):
        self.embedding_manager = EmbeddingManager()

        self.vector_db = VectorDBManager(
            persist_directory=vector_store_path,
            collection_name="documents",
        )

        self.vector_db.load_vector_store()

    def ingest_file(
        self,
        knowledge_document,
    ):
        """
        Extract, chunk, embed and store an uploaded file.
        """

        if not knowledge_document.file_path:
            raise ValueError(
                "Knowledge document does not have a file path."
            )

        file_path = Path(
            knowledge_document.file_path
        )

        text = extract_text_from_file(
            str(file_path)
        )

        if not text.strip():
            raise ValueError(
                "No readable text was extracted from the file."
            )

        document = Document(
            page_content=text,
            metadata={
                "source": str(file_path),
                "title": knowledge_document.title,
                "source_type": "file",
            },
        )

        return self._index_document(
            knowledge_document,
            document,
        )

    def ingest_url(
        self,
        knowledge_document,
    ):
        """
        Scrape, chunk, embed and store one URL.
        """

        if not knowledge_document.source_url:
            raise ValueError(
                "Knowledge document does not have a source URL."
            )

        scraped = scrape_single_url(
            knowledge_document.source_url
        )

        document = Document(
            page_content=scraped["text"],
            metadata={
                "source": scraped["url"],
                "title": scraped["title"],
                "source_type": "url",
            },
        )

        # If no title was supplied when the record was created,
        # use the scraped title.
        if not knowledge_document.title:
            knowledge_document.title = scraped["title"]

        return self._index_document(
            knowledge_document,
            document,
        )

    def _index_document(
        self,
        knowledge_document,
        document: Document,
    ):
        """
        Common pipeline:

        Document
            ↓
        chunks
            ↓
        embeddings
            ↓
        Chroma
        """

        chunks = split_docs([document])

        if not chunks:
            raise ValueError(
                "Document produced zero chunks."
            )

        embeddings = (
            self.embedding_manager.generate_embedding(
                chunks
            )
        )

        chunk_count = self.vector_db.add_documents(
            documents=chunks,
            embeddings=embeddings,
            knowledge_document_id=str(
                knowledge_document.id
            ),
        )

        return chunk_count

    def delete_vectors(
        self,
        knowledge_document_id,
    ):
        self.vector_db.delete_document(
            str(knowledge_document_id)
        )

    def reindex_file(
        self,
        knowledge_document,
    ):
        """
        Remove existing vectors and index the file again.
        """

        self.delete_vectors(
            knowledge_document.id
        )

        return self.ingest_file(
            knowledge_document
        )

    def reindex_url(
        self,
        knowledge_document,
    ):
        """
        Remove existing vectors and index the URL again.
        """

        self.delete_vectors(
            knowledge_document.id
        )

        return self.ingest_url(
            knowledge_document
        )