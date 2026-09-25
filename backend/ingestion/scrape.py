import re
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse


DEFAULT_TIMEOUT = 30


# Same selectors used by the original sitemap scraper.
REMOVE_SELECTORS = [
    "header",
    "nav",
    "footer",
    "script",
    "style",
    "noscript",
    "form",
    "aside",
    "iframe",

    # Webenza global footer
    "#footer-sec-webenza",
    "#privacy-policy-footer-webenza",

    # Webenza Specialisation section
    "section.footer-what",

    # Other common noise
    ".cookie-banner",
    ".related-posts",
    ".comments",
]


def extract_clean_text(html: str) -> tuple[str, str]:
    """
    Extract clean text and page title from HTML.

    Uses the same scraping/cleanup logic as the original
    sitemap scraper.
    """

    soup = BeautifulSoup(html, "lxml")

    # ---------------------------------------------
    # PAGE TITLE
    # ---------------------------------------------

    title_tag = soup.find("title")

    title = (
        title_tag.get_text(strip=True)
        if title_tag
        else ""
    )

    # ---------------------------------------------
    # PREFER MAIN CONTENT
    # ---------------------------------------------

    content = (
        soup.find("main")
        or soup.find("article")
        or soup.find("body")
    )

    if content is None:
        return "", ""

    # ---------------------------------------------
    # REMOVE UNWANTED ELEMENTS
    # ---------------------------------------------

    for selector in REMOVE_SELECTORS:
        for tag in content.select(selector):
            tag.decompose()

    # ---------------------------------------------
    # EXTRACT TEXT
    # ---------------------------------------------

    text = content.get_text(
        separator="\n",
        strip=True
    )

    # ---------------------------------------------
    # NORMALIZE WHITESPACE
    # ---------------------------------------------

    text = re.sub(r"\n{3,}", "\n\n", text)

    return text, title


def scrape_single_url(url: str) -> dict:
    """
    Scrape one URL and return its cleaned content.

    Unlike the original scraper, this function processes
    only the URL provided by the admin.
    """

    url = url.strip()

    if not url:
        raise ValueError("URL cannot be empty.")

    # ---------------------------------------------
    # VALIDATE URL
    # ---------------------------------------------

    parsed = urlparse(url)

    if parsed.scheme not in {"http", "https"}:
        raise ValueError(
            "Only HTTP and HTTPS URLs are supported."
        )

    # ---------------------------------------------
    # FETCH URL
    # ---------------------------------------------

    response = requests.get(
        url,
        timeout=DEFAULT_TIMEOUT,
        headers={
            "User-Agent": (
                "Mozilla/5.0 "
                "(compatible; KnowledgeBaseBot/1.0)"
            )
        },
    )

    response.raise_for_status()

    # ---------------------------------------------
    # CHECK CONTENT TYPE
    # ---------------------------------------------

    content_type = (
        response.headers
        .get("content-type", "")
        .lower()
    )

    if "text/html" not in content_type:
        raise ValueError(
            f"URL did not return an HTML page. "
            f"Content-Type: {content_type}"
        )

    # ---------------------------------------------
    # CLEAN PAGE
    # ---------------------------------------------

    text, title = extract_clean_text(
        response.text
    )

    # ---------------------------------------------
    # VALIDATE EXTRACTED CONTENT
    # ---------------------------------------------

    if len(text.strip()) < 100:
        raise ValueError(
            "The page did not contain enough readable "
            "text to ingest."
        )

    # ---------------------------------------------
    # RETURN
    # ---------------------------------------------

    return {
        "url": url,
        "title": title or url,
        "text": text,
        "char_count": len(text),
    }