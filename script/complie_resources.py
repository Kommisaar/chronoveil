import logging
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

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
    """Load compile configuration from a TOML file."""
    config_path = Path(config_file)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_file}")

    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    try:
        return config["tool"]["chronoveil"]["compiler"]
    except KeyError as exc:
        raise KeyError(f"Missing [tool.chronoveil.compiler] section in {config_file}") from exc


# ==============================
# Resource file collection
# ==============================

def collect_resource_files(resource_paths: list[str], resource_extensions: list[str]) -> list[Path]:
    """Collect all resource files from the configuration."""
    if not resource_paths:
        logger.warning("No resource paths specified, skipping")
        return []

    if not resource_extensions:
        logger.warning("No resource extensions specified, skipping")
        return []

    collected_resources = []
    allowed_extensions = set([ext.lstrip(".").lower() for ext in resource_extensions])
    for path_str in resource_paths:
        path = Path(path_str)
        if not path.exists():
            logger.warning(f"Resource path does not exist, skipping: {path}")
            continue

        if path.is_file():
            collected_resources.append(path)

        if path.is_dir():
            for file in path.glob("**/*"):
                if file.is_file() and file.suffix.lstrip(".").lower() in allowed_extensions:
                    collected_resources.append(file)

    logger.info(f"Collected {len(collected_resources)} resources")
    return collected_resources


# ==============================
# Compiler translation file
# ==============================
def compile_translation_files(ts_files: list[Path]) -> list[Path]:
    """Compile a translation file using Qt's lrelease tool."""
    if not ts_files:
        logger.info("No translation files found, skipping")
        return []

    logger.info(f"Compiling {len(ts_files)} translation file(s)...")

    complied_ts_files = []
    for ts_file in ts_files:
        target_file = ts_file.with_suffix(".qm")
        cmd = ["pyside6-lrelease"] + [str(ts_file)] + ["-qm", target_file]

        try:
            subprocess.run(cmd, check=True)
            complied_ts_files.append(target_file)
            logger.info(f"Translation file compiled: {target_file}")
        except subprocess.CalledProcessError as exc:
            logger.error(f"Error compiling translation file: {exc}")
            raise

    return complied_ts_files


# ==============================
# Build qrc file
# ==============================

def build_qrc_file(resource_files: list[Path], qrc_file: str) -> str | None:
    """Build a Qt resource file from the collected resources."""

    if not resource_files:
        logger.info("No resource files found, skipping")
        return None

    logger.info(f"Building qrc file for {len(resource_files)} resource file(s)")

    root = ElementTree.Element("RCC", attrib={"version": "1.0"})
    root.append(build_resource_node(resource_files, qrc_file))

    xml = ElementTree.ElementTree(root)
    ElementTree.indent(xml, space="  ", level=0)
    xml.write(qrc_file, encoding="utf-8", xml_declaration=True)

    logger.info(f"Qrc file built: {qrc_file}")
    return qrc_file


def build_resource_node(resource_files: list[Path], qrc_file: str) -> ElementTree.Element:
    resource_node = ElementTree.Element("qresource")
    resource_files.sort(key=lambda x: str(x))
    for file in resource_files:
        rel_path = file.relative_to(Path(qrc_file).parent)
        path_str = str(rel_path).replace("\\", "/")

        file_elem = ElementTree.SubElement(resource_node, "file")
        file_elem.text = path_str
    return resource_node


# ==============================
# Complier qrc file
# ==============================
def compile_qrc(qrc_file: str, compiled_file: str) -> None:
    if not qrc_file:
        logger.info("No qrc file specified, skipping")
        return

    if not compiled_file:
        logger.info("No compiled file specified, skipping")
        return

    logger.info(f"Compiling qrc file: {qrc_file}")

    cmd = ["pyside6-rcc"] + [qrc_file] + ["-o", compiled_file]

    try:
        subprocess.run(cmd, check=True)
        logger.info(f"Qrc file compiled: {compiled_file}")
    except subprocess.CalledProcessError as exc:
        logger.error(f"Error compiling qrc file: {exc}")
        raise


# ==============================
# Main Workflow
# ==============================
def main(config_file: str) -> None:
    logger.info("Starting resource compilation...")

    config = load_config(config_file)

    resource_paths = config["resource_paths"]
    resource_extensions = config["resource_extensions"]
    qrc_file = config["qrc_file"]
    compiled_file = config["compiled_file"]

    resource_files = collect_resource_files(resource_paths, resource_extensions)

    ts_files = [file for file in resource_files if file.suffix == ".ts"]
    general_files = [file for file in resource_files if file.suffix != ".ts"]

    final_files = general_files + compile_translation_files(ts_files)

    qrc_file = build_qrc_file(final_files, qrc_file)
    compile_qrc(qrc_file, compiled_file)

    logger.info("Resource files compiled successfully.")


if __name__ == "__main__":
    try:
        main("./pyproject.toml")
    except Exception as e:
        logger.exception(f"Compilation failed: {e}")
        sys.exit(1)
