FROM nginx:alpine
RUN printf 'server { listen 8080; location / { return 200 "ok\\n"; } location /health { return 200 "ok\\n"; } }\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
