FROM python:3.10-slim

# Install Node.js (18.x) and tools
RUN apt-get update && apt-get install -y curl build-essential ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

# Copy backend sources
COPY . /app

# Install Python requirements
COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --upgrade pip setuptools && \
    pip install --no-cache-dir -r requirements.txt

# Install Node dependencies
COPY package.json package-lock.json* /app/
RUN npm install --production

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

CMD ["npm", "start"]
