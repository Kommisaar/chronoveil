import numpy as np
from PySide6.QtGui import QImage
from PySide6.QtGui import QPixmap
from scipy.ndimage import gaussian_filter


def gaussian_blur_pixmap(pixmap: QPixmap, radius: int = 15) -> QPixmap:
    if radius <= 0:
        return pixmap

    image = pixmap.toImage()
    if image.format() != QImage.Format.Format_ARGB32:
        image = image.convertToFormat(QImage.Format.Format_ARGB32)

    ptr: memoryview = image.bits()
    arr = np.frombuffer(ptr, np.uint8).reshape((image.height(), image.width(), 4))

    r = arr[:, :, 2].astype(np.float32)
    g = arr[:, :, 1].astype(np.float32)
    b = arr[:, :, 0].astype(np.float32)
    a = arr[:, :, 3]

    r_filtered: np.ndarray = gaussian_filter(r, sigma=radius)
    g_filtered: np.ndarray = gaussian_filter(g, sigma=radius)
    b_filtered: np.ndarray = gaussian_filter(b, sigma=radius)

    r = r_filtered.astype(np.uint8)
    g = g_filtered.astype(np.uint8)
    b = b_filtered.astype(np.uint8)

    blurred_arr = np.stack([b, g, r, a], axis=2)
    blurred_image = QImage(blurred_arr.tobytes(), image.width(), image.height(), QImage.Format.Format_ARGB32)
    return QPixmap.fromImage(blurred_image)
