from pathlib import Path

from bs4 import BeautifulSoup
from pypdf import PdfReader
from docx import Document as DocxDocument


SUPPORTED_EXTENSIONS = {
    ".txt",
    ".md",
    ".html",
    ".htm",
    ".pdf",
    ".docx",
}


def extract_text_from_file(file_path: str) -> str:
    """
    Extract plain text from a supported document file.
    """

    path = Path(file_path)

    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    extension = path.suffix.lower()

    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type: {extension}. "
            f"Supported types: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )

    if extension in {".txt", ".md"}:
        return path.read_text(encoding="utf-8", errors="ignore").strip()

    if extension in {".html", ".htm"}:
        html = path.read_text(encoding="utf-8", errors="ignore")

        soup = BeautifulSoup(html, "lxml")

        for tag in soup(
            ["script", "style", "noscript", "nav", "footer", "header", "form"]
        ):
            tag.decompose()

        return soup.get_text(separator="\n", strip=True)

    if extension == ".pdf":
        return extract_pdf_text(path)

    if extension == ".docx":
        return extract_docx_text(path)

    raise ValueError(f"Unsupported file type: {extension}")


def extract_pdf_text(path: Path) -> str:
    reader = PdfReader(str(path))

    pages = []

    for page in reader.pages:
        text = page.extract_text() or ""

        if text.strip():
            pages.append(text.strip())

    return "\n\n".join(pages).strip()


def extract_docx_text(path: Path) -> str:
    document = DocxDocument(str(path))

    paragraphs = []

    for paragraph in document.paragraphs:
        text = paragraph.text.strip()

        if text:
            paragraphs.append(text)

    return "\n\n".join(paragraphs).strip()