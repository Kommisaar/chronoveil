import logging
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

# ==============================
# Logging setup
# ==============================

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# ==============================
# Configuration loading
# ==============================

def load_config(config_file: str) -> dict[str, Any]:
    """Load translation configuration from a TOML file."""
    config_path = Path(config_file)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_file}")

    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    try:
        return config["tool"]["chronoveil"]["translations"]
    except KeyError as exc:
        raise KeyError(f"Missing [tool.chronoveil.translations] section in {config_file}") from exc


# ==============================
# Source file collection
# ==============================

def collect_python_files(source_paths: list[str]) -> list[Path]:
    """Collect all relevant Python source files from given paths."""
    collected_files: list[Path] = []

    for path_str in source_paths:
        path = Path(path_str)
        if not path.exists():
            logger.warning(f"Source path does not exist, skipping: {path}")
            continue

        if path.is_file():
            collected_files.append(path)
        else:
            for py_file in path.rglob("*.py"):
                if py_file.name != "__init__.py":
                    collected_files.append(py_file)

    logger.info(f"Collected {len(collected_files)} Python files")
    return collected_files


# ==============================
# Translation update logic
# ==============================

def update_translation_files(source_files: list[Path], locales: list[dict[str, str]]) -> None:
    """Run pyside6-lupdate to update .ts translation files."""
    if not source_files:
        logger.warning("No source files specified; skipping update")
        return

    if not locales:
        logger.warning("No translation files specified; skipping update")
        return

    logger.info(f"Updating {len(locales)} translation file(s)")
    source_paths = [str(f) for f in source_files]

    for locale in locales:
        ts_file = locale["file"]
        language = locale["language"]

        file_path = Path(ts_file)
        if not file_path.parent.exists():
            file_path.parent.mkdir(parents=True, exist_ok=True)

        cmd = ["pyside6-lupdate"] + ["-target-language", language, "-no-obsolete"] + source_paths + ["-ts", ts_file]
        try:
            subprocess.run(cmd, check=True)
            logger.info(f"Successfully updated: {ts_file}")
        except subprocess.CalledProcessError as error:
            logger.error(f"Failed to update {ts_file} (exit code: {error.returncode})")
            raise


# ==============================
# Main workflow
# ==============================

def main(config_file: str) -> None:
    """Main entry point to update translation files based on config."""
    logger.info("Starting translation update...")

    config = load_config(config_file)

    source_paths = config["source_paths"]
    locales = config["locale"]

    source_files = collect_python_files(source_paths)
    update_translation_files(source_files, locales)

    logger.info("Translation files updated successfully")


# ==============================
# Script execution
# ==============================

if __name__ == "__main__":
    try:
        main("./pyproject.toml")
    except Exception as e:
        logger.exception(f"Translation update failed: {e}")
        sys.exit(1)
