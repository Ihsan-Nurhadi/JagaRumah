FROM python:3.11-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Unduh bobot ringan YOLO11n ONNX (~10 MB) tanpa perlu instalasi PyTorch (hemat RAM VPS)
RUN mkdir -p /app/models \
  && (curl -fSL --retry 3 -o /app/models/yolo11n.onnx "https://huggingface.co/aaurelions/yolo11n.onnx/resolve/main/yolo11n.onnx" \
      || curl -fSL --retry 3 -o /app/models/yolo11n.onnx "https://huggingface.co/booknerd/yolov11/resolve/main/yolo11n.onnx" \
      || curl -fSL --retry 3 -o /app/models/yolo11n.onnx "https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx" \
      || echo "[onvif-worker] Peringatan: gagal mengunduh model ONNX saat build, mount manual ke /app/models/yolo11n.onnx")

COPY vehicle_detector.py .
COPY worker.py .

CMD ["python", "worker.py"]
