# Use the official Python 3.10 slim image
FROM python:3.10-slim

# Set the working directory
WORKDIR /app

# Install system dependencies required for OpenCV
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose port 7860 (Hugging Face Spaces default port)
EXPOSE 7860

# Set environment variables for Flask
ENV FLASK_APP=app.py
ENV PYTHONUNBUFFERED=1

# Create the uploads directory with correct permissions
RUN mkdir -p /app/uploads && chmod 777 /app/uploads

# Run the application using Gunicorn
# Using 1 worker and multiple threads due to background thread processing in app.py
CMD ["gunicorn", "--bind", "0.0.0.0:7860", "--workers", "1", "--threads", "8", "--timeout", "120", "app:app"]
