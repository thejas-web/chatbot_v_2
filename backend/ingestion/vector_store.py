import os
from pathlib import Path
from backend.config import VECTOR_STORE_DIR
import chromadb


class VectorDBManager:

    def __init__(
        self,
        persist_directory: str = VECTOR_STORE_DIR,
        collection_name: str = "documents"
    ):
        self.collection_name = collection_name
        self.persist_directory = persist_directory
        self.client = None
        self.collection = None

    def load_vector_store(self):
        """
        Initialize Chroma persistent client and collection.
        """

        Path(self.persist_directory).mkdir(
            parents=True,
            exist_ok=True,
        )

        self.client = chromadb.PersistentClient(
            path=self.persist_directory
        )

        self.collection = self.client.get_or_create_collection(
            name=self.collection_name,
            metadata={
                "description": "RAG Documents for chatbot",
                "hnsw:space": "cosine",
            },
        )

        return self.collection

    def _ensure_collection(self):
        if self.collection is None:
            self.load_vector_store()

    def add_documents(
        self,
        documents,
        embeddings,
        knowledge_document_id: str,
    ):
        """
        Add chunks and embeddings belonging to one
        KnowledgeDocument.
        """

        self._ensure_collection()

        if len(documents) != len(embeddings):
            raise ValueError(
                "The number of documents and embeddings "
                "must be the same."
            )

        ids = []
        metadatas = []
        contents = []
        embedding_values = []

        for index, (doc, embedding) in enumerate(
            zip(documents, embeddings)
        ):
            vector_id = (
                f"{knowledge_document_id}_chunk_{index}"
            )

            metadata = dict(doc.metadata)

            metadata["knowledge_document_id"] = (
                str(knowledge_document_id)
            )

            metadata["chunk_index"] = index
            metadata["content_length"] = len(
                doc.page_content
            )

            ids.append(vector_id)
            metadatas.append(metadata)
            contents.append(doc.page_content)

            embedding_values.append(
                embedding.tolist()
                if hasattr(embedding, "tolist")
                else embedding
            )

        if not ids:
            raise ValueError(
                "No chunks were provided for indexing."
            )

        self.collection.add(
            ids=ids,
            metadatas=metadatas,
            documents=contents,
            embeddings=embedding_values,
        )

        return len(ids)

    def delete_document(
        self,
        knowledge_document_id: str,
    ):
        """
        Delete all Chroma chunks belonging to one
        KnowledgeDocument.
        """

        self._ensure_collection()

        self.collection.delete(
            where={
                "knowledge_document_id": str(
                    knowledge_document_id
                )
            }
        )

    def get_document_chunk_count(
        self,
        knowledge_document_id: str,
    ) -> int:
        """
        Return number of Chroma chunks belonging to
        a KnowledgeDocument.
        """

        self._ensure_collection()

        result = self.collection.get(
            where={
                "knowledge_document_id": str(
                    knowledge_document_id
                )
            },
            include=[],
        )

        return len(result["ids"])