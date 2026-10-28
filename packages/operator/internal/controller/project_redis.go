/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"crypto/tls"
	"fmt"
	"sync"

	"github.com/redis/go-redis/v9"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

// RedisFor opens the Redis of a project, where the operator writes replica records
// and routing.
type RedisFor func(ctx context.Context, project *canyonosv1alpha1.CanyonProject) (redis.Cmdable, error)

// RedisLogin is the fingerprint of the login a project's pods use for its Redis,
// for builders.StampRedisLogin.
type RedisLogin func(ctx context.Context, project *canyonosv1alpha1.CanyonProject) (string, error)

// ProjectRedis keeps one client per project's Redis, opened again when its address
// or password changes (a rotated password, a project switched to an external Redis).
type ProjectRedis struct {
	// Reader reads the password Secret straight from the API server.
	Reader  client.Reader
	mu      sync.Mutex
	clients map[string]cachedRedis
}

type cachedRedis struct {
	fingerprint string
	client      *redis.Client
}

// For is a RedisFor.
func (p *ProjectRedis) For(ctx context.Context, project *canyonosv1alpha1.CanyonProject) (redis.Cmdable, error) {
	options, err := p.options(ctx, project)
	if err != nil {
		return nil, err
	}
	fingerprint := fmt.Sprintf("%s\x00%s\x00%s\x00%t", options.Addr, options.Username, options.Password,
		options.TLSConfig != nil)
	key := project.Namespace + "/" + project.Name

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.clients == nil {
		p.clients = map[string]cachedRedis{}
	}
	if cached, ok := p.clients[key]; ok {
		if cached.fingerprint == fingerprint {
			return cached.client, nil
		}
		_ = cached.client.Close()
	}
	rdb := redis.NewClient(options)
	p.clients[key] = cachedRedis{fingerprint: fingerprint, client: rdb}
	return rdb, nil
}

// Login is a RedisLogin: the SecretVersion of the Secret with the login, which
// changes with the password and tells nothing about it. Empty when the project's
// Redis takes no password.
func (p *ProjectRedis) Login(ctx context.Context, project *canyonosv1alpha1.CanyonProject) (string, error) {
	secret, err := p.loginSecret(ctx, project)
	if err != nil || secret == nil {
		return "", err
	}
	return builders.SecretVersion(secret), nil
}

// options says how to reach and log in to a project's Redis, as its pods do.
func (p *ProjectRedis) options(ctx context.Context, project *canyonosv1alpha1.CanyonProject) (*redis.Options, error) {
	host, port := builders.RedisHostPort(project)
	options := &redis.Options{Addr: fmt.Sprintf("%s:%d", host, port)}
	redisSpec := project.Spec.Redis
	if redisSpec.Mode == redisExternal && redisSpec.TLS {
		options.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: redisSpec.Host}
	}
	secret, err := p.loginSecret(ctx, project)
	if err != nil {
		return nil, err
	}
	if secret != nil {
		options.Password = string(secret.Data[builders.RedisPasswordKey])
		options.Username = string(secret.Data["username"])
	}
	return options, nil
}

// loginSecret is the Secret with the password (and optional username) the project's
// pods log in to its Redis with: the operator's for its own Redis, the customer's for
// an external one, or nil when an external Redis takes no password.
func (p *ProjectRedis) loginSecret(ctx context.Context, project *canyonosv1alpha1.CanyonProject) (*corev1.Secret, error) {
	name := builders.RedisName
	if project.Spec.Redis.Mode == redisExternal {
		if project.Spec.Redis.PasswordSecretRef == "" {
			return nil, nil
		}
		name = project.Spec.Redis.PasswordSecretRef
	}
	return p.secret(ctx, project.Namespace, name)
}

func (p *ProjectRedis) secret(ctx context.Context, namespace, name string) (*corev1.Secret, error) {
	secret := &corev1.Secret{}
	err := p.Reader.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, secret)
	if apierrors.IsNotFound(err) {
		return nil, fmt.Errorf("the Redis password Secret %s/%s does not exist", namespace, name)
	}
	return secret, err
}
