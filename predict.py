import sys
import json
import tensorflow as tf
import numpy as np
from PIL import Image

import os

# Allow overriding model and class filenames via environment variables.
MODEL_PATH = os.environ.get('MODEL_FILE', 'trained_model.h5')
CLASS_PATH = os.environ.get('CLASS_FILE', 'class_names.txt')


def load_model_with_fallback(model_path):
    """Try several strategies to load an HDF5 Keras model:
    1) tf.keras.models.load_model
    2) standalone keras.models.load_model (if `keras` package is installed)
    3) use a LegacyInputLayer shim that removes `batch_shape` from configs
    This helps when the model was saved with a different Keras/TF version.
    """
    # Primary: TensorFlow's Keras
    try:
        return tf.keras.models.load_model(model_path)
    except Exception as e_primary:
        # Secondary: try standalone keras (if available)
        try:
            import keras
            return keras.models.load_model(model_path)
        except Exception:
            # Final fallback: shim InputLayer.from_config to ignore `batch_shape`
            try:
                class LegacyInputLayer(tf.keras.layers.InputLayer):
                    @classmethod
                    def from_config(cls, config):
                        # copy and remove unknown keys that break deserialization
                        config = dict(config)
                        config.pop('batch_shape', None)
                        return super(LegacyInputLayer, cls).from_config(config)

                # Shim for DTypePolicy used inside Rescaling configs when model was saved
                class DTypePolicyShim:
                    def __init__(self, name='float32'):
                        self.name = name

                    def get_config(self):
                        return {'name': self.name}

                    @classmethod
                    def from_config(cls, config):
                        return cls(**(config or {}))

                # Ensure Rescaling maps to tf.keras.layers.Rescaling if available
                custom = {
                    'InputLayer': LegacyInputLayer,
                    'DTypePolicy': DTypePolicyShim,
                }

                # Try to add Rescaling from tf.keras.layers if present
                try:
                    custom['Rescaling'] = tf.keras.layers.Rescaling
                except Exception:
                    pass

                return tf.keras.models.load_model(model_path, custom_objects=custom)
            except Exception as e_fallback:
                # If all attempts fail, raise the last error with context
                raise RuntimeError(
                    f"Failed to load model '{model_path}'. Tried tf.keras, keras and a fallback shim. Last error: {e_fallback}"
                ) from e_fallback


# Load model ONCE (with fallbacks)
# If MODEL_PATH doesn't exist but there is another .h5 file (e.g. trained_modeule.h5), use it.
if not os.path.exists(MODEL_PATH):
    candidates = [p for p in os.listdir('.') if p.lower().endswith('.h5')]
    if candidates:
        print(f"MODEL_PATH {MODEL_PATH} not found; using first .h5 candidate: {candidates[0]}")
        MODEL_PATH = candidates[0]

model = load_model_with_fallback(MODEL_PATH)

# Load class names (fallback to any .txt if configured name not found)
if not os.path.exists(CLASS_PATH):
    candidates = [p for p in os.listdir('.') if p.lower().endswith('.txt')]
    if candidates:
        print(f"CLASS_PATH {CLASS_PATH} not found; using first .txt candidate: {candidates[0]}")
        CLASS_PATH = candidates[0]

with open(CLASS_PATH, "r") as f:
    class_names = [line.strip() for line in f.readlines()]

def preprocess_image(image_path):
    img = Image.open(image_path).convert("RGB")
    img = img.resize((224, 224))  # Adjust if your model uses another size
    img = np.array(img) / 255.0   # normalize
    img = np.expand_dims(img, axis=0)
    return img

def analyze_image(image_path):
    try:
        img = preprocess_image(image_path)
        preds = model.predict(img)
        class_id = int(np.argmax(preds))
        confidence = float(np.max(preds))

        return {
            "label": class_names[class_id],
            "confidence": confidence
        }

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No image path provided"}))
        sys.exit(1)

    image_path = sys.argv[1]
    result = analyze_image(image_path)
    print(json.dumps(result))
