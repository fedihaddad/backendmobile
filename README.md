# Backend - Plant Classifier & Server

This backend exposes Node.js endpoints and calls a Python script to analyze uploaded plant images using the `plant_classifier.h5` Keras model.

Important: These instructions show how to install dependencies globally (no virtual environment) as requested.

Prerequisites
- Python 3.8+ installed and available as `python`, `python3`, or `py` in your PATH.
- Node.js and npm installed.

Install (global Python packages)
Open PowerShell as your normal user and run:

```powershell
# Install Python packages globally (no venv)
pip install --upgrade pip
pip install tensorflow pillow numpy

# If you prefer CPU-only TensorFlow on systems without GPU support, you can try:
# pip install tensorflow-cpu
```

Install Node dependencies and start server

```powershell
# From this backend folder
npm install
npm start
```

Usage
- POST `/api/analyze` with `multipart/form-data` containing an `image` field (file).
- The Node server will call `predict.py` and return JSON with `label` and `confidence`.

Notes & Troubleshooting
- The server tries to find `python`, `python3`, or `py` automatically. Ensure one is in PATH.
- Installing TensorFlow globally may require administrative rights on some machines. If install fails, consider using a per-user install: `pip install --user tensorflow pillow numpy`.
- The included `predict.py` already loads `plant_classifier.h5` and `class_names.txt`.

If you want, I can add an HTTP-based Python predictor instead of spawning a process (makes repeated requests faster).
